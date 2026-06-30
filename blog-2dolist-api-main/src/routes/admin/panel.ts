import { FastifyPluginAsync } from 'fastify';

const page = (title: string, content: string, scripts = '') => `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${title}</title>
<style>
body{font-family:Inter,Arial,sans-serif;max-width:1040px;margin:0 auto;padding:2rem;background:#f9fafb;color:#111827}
.card{background:white;border-radius:12px;padding:1rem 1.2rem;box-shadow:0 2px 12px rgba(0,0,0,.06);margin-bottom:1rem}
input,select,textarea,button{width:100%;padding:.7rem;margin:.3rem 0;border:1px solid #d1d5db;border-radius:8px}
button{background:#111827;color:white;cursor:pointer} h1,h2{margin:.2rem 0 1rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:1rem}
.row{display:grid;grid-template-columns:1fr 1fr;gap:.6rem}
small{color:#6b7280}
label{font-size:.92rem;color:#374151;display:block;margin-top:.2rem}
.req{color:#b91c1c;font-weight:700}
.field-help{font-size:.82rem;color:#6b7280;margin-top:-.1rem;margin-bottom:.35rem}
.check-row{display:flex;gap:1rem;align-items:center;margin:.3rem 0}
.check-row label{display:flex;align-items:center;gap:.35rem;font-size:.95rem}
.check-row input{width:auto;margin:0}
.error-box{display:none;padding:.6rem .75rem;background:#fee2e2;color:#991b1b;border:1px solid #fecaca;border-radius:8px;margin:.5rem 0}
.info-box{padding:.6rem .75rem;background:#eff6ff;color:#1e3a8a;border:1px solid #bfdbfe;border-radius:8px;margin:.5rem 0}
</style></head><body>${content}${scripts}</body></html>`;

export const adminPanelRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/admin', async (_, reply) => reply.type('text/html').send(page('Admin Login', `
    <div class="card">
      <h1>The Muscle Temple - Admin</h1>
      <form id="loginForm">
        <input type="email" name="email" placeholder="Email admin" required />
        <input type="password" name="password" placeholder="Mot de passe" required />
        <button type="submit">Se connecter</button>
      </form>
      <small>Le token JWT est stocké en localStorage pour cette version.</small>
    </div>
  `, `<script>
  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const r = await fetch('/admin-api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:form.get('email'),password:form.get('password')})});
    const j = await r.json();
    if(!r.ok){alert(j.message||'Erreur auth');return;}
    localStorage.setItem('adminToken', j.data.token);
    location.href='/admin/dashboard';
  });
  </script>`)));

  fastify.get('/admin/dashboard', async (_, reply) => reply.type('text/html').send(page('Dashboard', `
    <h1>Dashboard Admin</h1>
    <div class="grid" id="stats"></div>

    <div class="card"><h2>Créer un article</h2>
      <div class="info-box"><b>Champs requis</b>: Titre, Contenu, Author ID.<br/><b>Contenu HTML</b>: colle le contenu HTML généré par ton éditeur.<br/>Optionnels: catégorie, tags, articles liés, SEO.</div>
      <div id="postError" class="error-box"></div>
      <form id="postForm">
      <label for="title">Titre <span class="req">*</span></label>
      <input id="title" name="title" placeholder="Ex: Programme prise de masse" minlength="4" required />
      <div class="field-help">Minimum 4 caractères.</div>
      <textarea name="excerpt" placeholder="Résumé"></textarea>
      <label for="contentHtml">Contenu (HTML) <span class="req">*</span></label>
      <textarea id="contentHtml" name="contentHtml" placeholder="<h2>Mon article</h2><p>Contenu...</p>" rows="8" minlength="10" required></textarea>
      <div class="field-help">Minimum 10 caractères. Tu peux coller le HTML généré par ton éditeur.</div>
      <div class="row"><div><label for="authorId">Author ID <span class="req">*</span></label><input id="authorId" name="authorId" placeholder="ID auteur existant" required /></div><div><label for="categoryId">Category ID</label><input id="categoryId" name="categoryId" placeholder="optionnel" /></div></div>
      <div class="row"><select name="status"><option value="DRAFT">Brouillon</option><option value="PUBLISHED">Publié</option></select><input name="readingTimeMinutes" type="number" placeholder="Temps de lecture" /></div>
      <div class="check-row"><label><input type="checkbox" name="isActive" />actif</label><label><input type="checkbox" name="isIndexable" />indexable</label></div>
      <input name="tagIds" placeholder="Tag IDs (séparés par virgules)" />
      <input name="relatedPostIds" placeholder="Related Post IDs (séparés par virgules)" />
      <h3>SEO</h3>
      <input name="seoTitle" placeholder="SEO title" /><textarea name="seoDescription" placeholder="SEO description"></textarea><input name="canonicalUrl" placeholder="Canonical URL" />
      <button type="submit">Créer</button></form>
    </div>

    <div class="card"><h2>Articles</h2><div id="postsList"></div></div>
    <div class="card"><h2>Catégories</h2><div id="categoriesList"></div></div>
    <div class="card"><h2>Auteurs</h2><div id="authorsList"></div></div>
  `, `<script>
  const token = localStorage.getItem('adminToken');
  if(!token) location.href='/admin';
  const headers = {'content-type':'application/json','authorization':'Bearer '+token};

  function showPostError(message){
    const box = document.getElementById('postError');
    box.style.display = message ? 'block' : 'none';
    box.textContent = message || '';
  }

  async function boot(){
    const [dash, posts, categories, authors] = await Promise.all([
      fetch('/admin-api/dashboard',{headers}), fetch('/admin-api/posts',{headers}), fetch('/admin-api/categories',{headers}), fetch('/admin-api/authors',{headers})
    ]);
    if(dash.status===401){localStorage.removeItem('adminToken'); location.href='/admin';return;}
    const d = await dash.json();
    document.getElementById('stats').innerHTML = Object.entries(d.data).map(([k,v])=>'<div class="card"><b>'+k+'</b><div>'+v+'</div></div>').join('');
    document.getElementById('postsList').innerHTML = (await posts.json()).data.map(p=>'<div><b>'+p.title+'</b> ('+p.status+') - '+p.slug+'</div>').join('') || 'Aucun article';
    document.getElementById('categoriesList').innerHTML = (await categories.json()).data.map(c=>'<div>'+c.name+' - '+c.slug+'</div>').join('') || 'Aucune catégorie';
    document.getElementById('authorsList').innerHTML = (await authors.json()).data.map(a=>'<div>'+a.name+' - '+a.slug+'</div>').join('') || 'Aucun auteur';
  }
  boot();

  document.getElementById('postForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    showPostError('');
    const form = e.target;
    const title = form.querySelector('[name="title"]').value.trim();
    const contentHtml = form.querySelector('[name="contentHtml"]').value.trim();
    const authorId = form.querySelector('[name="authorId"]').value.trim();
    if(title.length < 4) return showPostError('Le titre doit contenir au moins 4 caractères.');
    if(contentHtml.length < 10) return showPostError('Le contenu HTML doit contenir au moins 10 caractères.');
    if(!authorId) return showPostError('Author ID est obligatoire.');
    const f = new FormData(form);
    const body = {
      title: f.get('title'), excerpt: f.get('excerpt') || undefined, contentHtml: f.get('contentHtml'),
      authorId: f.get('authorId'), categoryId: f.get('categoryId') || null, status: f.get('status'),
      isActive: f.get('isActive') === 'on', isIndexable: f.get('isIndexable') === 'on',
      readingTimeMinutes: f.get('readingTimeMinutes') ? Number(f.get('readingTimeMinutes')) : null,
      tagIds: (f.get('tagIds')||'').toString().split(',').map(x=>x.trim()).filter(Boolean),
      relatedPostIds: (f.get('relatedPostIds')||'').toString().split(',').map(x=>x.trim()).filter(Boolean),
      seo: { title: f.get('seoTitle') || '', description: f.get('seoDescription') || '', canonicalUrl: f.get('canonicalUrl') || '', noIndex: false }
    };
    const res = await fetch('/admin-api/posts',{method:'POST',headers,body:JSON.stringify(body)});
    let json = null;
    try { json = await res.json(); } catch { /* noop */ }

    if(!res.ok){
      const message = json?.message || 'Erreur sauvegarde. Vérifie: title>=4, contentHtml>=10, authorId valide.';
      showPostError(message);
      return;
    }

    alert('Article créé');
    e.target.reset();
    boot();
  });
  </script>`)));
};
