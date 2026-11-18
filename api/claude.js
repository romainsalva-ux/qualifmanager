// Relais vers l'API Anthropic. La clé reste sur le serveur : le navigateur
// envoie seulement le contenu à analyser.
//
// Variable requise : ANTHROPIC_API_KEY

const MODELE = 'claude-sonnet-4-6';
const MAX_TOKENS_PLAFOND = 8000;
const MAX_CORPS = 12 * 1024 * 1024; // 12 Mo (une image encodée en base64 est volumineuse)

// Selon le runtime, Vercel peut avoir déjà lu et analysé le corps de la
// requête. Dans ce cas le flux est consommé et l'attendre bloquerait jusqu'au
// délai d'expiration : on se sert de req.body quand il est là.
function lireJson(req) {
  if (req.body !== undefined && req.body !== null && req.body !== '') {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
    const texte = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body);
    try { return Promise.resolve(JSON.parse(texte)); }
    catch { return Promise.reject(Object.assign(new Error('Corps de requête invalide'), { statut: 400 })); }
  }

  return new Promise((resolve, reject) => {
    const morceaux = [];
    let taille = 0;
    let fini = false;
    // Filet de sécurité : si le flux est déjà consommé, aucun évènement
    // n'arrivera jamais. On renonce plutôt que de laisser la requête pendre.
    const minuteur = setTimeout(() => {
      if (!fini) { fini = true; reject(Object.assign(new Error('Corps de requête illisible'), { statut: 400 })); }
    }, 10000);
    const terminer = (fn, arg) => { if (!fini) { fini = true; clearTimeout(minuteur); fn(arg); } };

    req.on('data', (c) => {
      taille += c.length;
      if (taille > MAX_CORPS) {
        terminer(reject, Object.assign(new Error('Requête trop volumineuse'), { statut: 413 }));
        req.destroy();
        return;
      }
      morceaux.push(c);
    });
    req.on('end', () => {
      try { terminer(resolve, JSON.parse(Buffer.concat(morceaux).toString('utf8'))); }
      catch { terminer(reject, Object.assign(new Error('Corps de requête invalide'), { statut: 400 })); }
    });
    req.on('error', (e) => terminer(reject, e));
  });
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(204).end();

  // Diagnostic : de quoi repérer une clé tronquée ou mal collée, sans la dévoiler.
  if (req.method === 'GET') {
    const brut = process.env.ANTHROPIC_API_KEY || '';
    const k = brut.trim();
    return res.status(200).json({
      fonction: 'claude',
      cleConfiguree: !!k,
      longueurCle: k.length || null,
      espacesParasites: brut !== k,
      debutAttendu: k ? k.startsWith('sk-ant-api') : null,
      quatreDerniers: k ? k.slice(-4) : null,
      modele: MODELE,
      runtime: process.version,
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  // Un retour à la ligne collé par mégarde suffirait à faire rejeter la clé.
  const cle = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!cle) {
    return res.status(500).json({ error: "Analyse IA non configurée sur le serveur" });
  }

  // Refuse les appels venant d'un autre site
  const origine = req.headers.origin || '';
  const hote = req.headers.host || '';
  if (origine && !origine.endsWith(hote)) {
    return res.status(403).json({ error: 'Origine non autorisée' });
  }

  try {
    const entree = await lireJson(req);
    if (!Array.isArray(entree.messages) || !entree.messages.length) {
      return res.status(400).json({ error: 'Aucun message à analyser' });
    }

    // Le client ne choisit ni le modèle ni le volume : on borne les deux.
    const charge = {
      model: MODELE,
      max_tokens: Math.min(Number(entree.max_tokens) || 4000, MAX_TOKENS_PLAFOND),
      messages: entree.messages,
    };

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cle,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(charge),
    });

    const data = await r.json();
    if (!r.ok) {
      console.error('Anthropic', r.status, JSON.stringify(data).slice(0, 300));
      return res.status(r.status).json({ error: data?.error?.message || "L'analyse a échoué" });
    }
    return res.status(200).json(data);
  } catch (e) {
    const statut = e.statut || 500;
    if (statut === 500) console.error('Proxy IA:', e);
    return res.status(statut).json({ error: e.message || 'Analyse impossible' });
  }
};

module.exports.config = { api: { bodyParser: false } };
