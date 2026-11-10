// Autorisation d'envoi vers Cloudflare R2.
//
// Le navigateur ne détient plus aucun identifiant : il demande ici une
// autorisation signée, valable quelques minutes et pour un seul nom de
// fichier choisi par le serveur, puis envoie le fichier directement à R2.
// Les fichiers ne transitent donc pas par cette fonction : pas de limite
// de taille de requête, et le secret R2 reste sur le serveur.
//
// Variables d'environnement requises :
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL

const crypto = require('crypto');

const VALIDITE_SECONDES = 300; // 5 minutes
const TYPES_AUTORISES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const encodeRFC3986 = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// Le nom de l'objet est décidé ici, jamais par le client : personne ne peut
// viser un fichier existant pour l'écraser.
function construireCle(nomPropose) {
  let nom = 'fichier';
  try { nom = decodeURIComponent(String(nomPropose || '')); } catch { nom = String(nomPropose || ''); }
  const base = nom.split(/[/\\]/).pop()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // accents
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(-80) || 'fichier';
  return `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}-${base}`;
}

function signerUrl(cle, env) {
  const host = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const dateStr = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const dateShort = dateStr.slice(0, 8);
  const scope = `${dateShort}/auto/s3/aws4_request`;

  const params = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${env.R2_ACCESS_KEY_ID}/${scope}`,
    'X-Amz-Date': dateStr,
    'X-Amz-Expires': String(VALIDITE_SECONDES),
    'X-Amz-SignedHeaders': 'host',
  };
  const requete = Object.keys(params).sort()
    .map((k) => `${encodeRFC3986(k)}=${encodeRFC3986(params[k])}`).join('&');

  const chemin = `/${env.R2_BUCKET}/${cle.split('/').map(encodeRFC3986).join('/')}`;
  const canonicalRequest =
    `PUT\n${chemin}\n${requete}\nhost:${host}\n\nhost\nUNSIGNED-PAYLOAD`;
  const stringToSign = `AWS4-HMAC-SHA256\n${dateStr}\n${scope}\n${sha256(canonicalRequest)}`;

  const kDate = hmac('AWS4' + env.R2_SECRET_ACCESS_KEY, dateShort);
  const kRegion = hmac(kDate, 'auto');
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return `https://${host}${chemin}?${requete}&X-Amz-Signature=${signature}`;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const env = process.env;
  const manquantes = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_URL']
    .filter((v) => !env[v]);
  if (manquantes.length) {
    console.error('Variables R2 absentes :', manquantes.join(', '));
    return res.status(500).json({ error: 'Stockage non configuré sur le serveur' });
  }

  // Refuse les appels émis depuis un autre site
  const origine = req.headers.origin || '';
  const hote = req.headers.host || '';
  if (origine && !origine.endsWith(hote)) {
    return res.status(403).json({ error: 'Origine non autorisée' });
  }

  const type = String(req.headers['x-type-fichier'] || '').split(';')[0].trim();
  if (!TYPES_AUTORISES.includes(type)) {
    return res.status(415).json({ error: `Type de fichier non accepté : ${type || 'inconnu'}` });
  }

  try {
    const cle = construireCle(req.headers['x-nom-fichier']);
    const base = env.R2_PUBLIC_URL.replace(/\/+$/, '');
    return res.status(200).json({
      uploadUrl: signerUrl(cle, env),
      url: `${base}/${cle}`,
      key: cle,
      expiresIn: VALIDITE_SECONDES,
    });
  } catch (e) {
    console.error('Signature:', e);
    return res.status(500).json({ error: "Impossible de préparer l'envoi" });
  }
};
