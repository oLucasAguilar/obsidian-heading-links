const { open, sleep } = require('./obsidian-demo.cjs');
const P = require('path').resolve(__dirname, '..'), T = process.env.THEME, O = process.env.OUTDIR || require('path').resolve(__dirname, '../docs');
const RECIPES = '## Bread\n\n### Sourdough\n\nStarter, flour, water.\n\n## Soup\n\nLeeks and potatoes.\n';
const base = { id: 'heading-links', pluginDir: P, files: ['main.js', 'manifest.json', 'styles.css'], theme: T };
(async () => {
  // breadcrumbs: a nested heading link reads as a path once the cursor leaves it
  let d = await open({ ...base, width: 640, height: 260, notes: { 'Recipes.md': RECIPES, 'Today.md': 'Bake tonight:\n\n' }, openNote: 'Today' });
  await d.focusEnd(); await d.hold(900);
  await d.type('[[Recipes#Bread#Sourdough]]', 50); await d.type('\n', 200); await sleep(600); await d.hold(3000);
  console.log(await d.gif(`${O}/breadcrumbs-${T}.gif`)); await d.close();
  // backlinks: nothing links to Soup; a new link puts Today at the end of the heading, and ctrl+hover previews it
  d = await open({ ...base, width: 980, height: 420, notes: { 'Recipes.md': RECIPES, 'Today.md': 'Dinner:\n\n' }, openNote: 'Today' });
  await d.split('Recipes.md'); await d.focusLeaf(0); await d.focusEnd(); await sleep(800); await d.hold(1500);
  await d.type('[[Recipes#Soup]]', 50); await d.type('\n', 200);
  const name = () => d.js(() => {
    const el = [...document.querySelectorAll('.heading-links-ref')].find(e => e.textContent.trim() == 'Today');
    if (!el) return null; el.id = 'demo-name'; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  let n = null; for (let i = 0; i < 40 && !n; i++) { n = await name(); if (!n) await sleep(300); }
  await d.hold(1800);
  await d.pointer(n.x, n.y, { steps: 16, ms: 50 }); await d.hold(500);
  // key events do not reach the unfocused window, so the hover carries ctrl itself
  await d.badge('Ctrl + hover');
  await d.js(() => { const el = document.getElementById('demo-name'), r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, ctrlKey: true, clientX: r.x + 4, clientY: r.y + 4 })); });
  await d.live(1500); await d.badge(''); await d.hold(2500);
  console.log('popover:', await d.js(() => !!document.querySelector('.hover-popover')));
  console.log(await d.gif(`${O}/backlinks-${T}.gif`)); await d.close();
})().catch(e => { console.error(e); process.exit(1); });
