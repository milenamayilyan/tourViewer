# 360° Tour Builder (multi-land)

Build clickable 360° tours in the browser. Each **land** is its own project with its own photos, points and link.
No images are bundled. Vite + Three.js, no Marzipano.

## Editor
Open the site with `?edit` (e.g. `https://YOU.github.io/REPO/?edit`). Before anything is published, the editor opens by itself.

- **Lands**: dropdown at the top of the editor panel. `+ New land`, ✎ rename, ✕ delete, `Copy link to this land`.
- **+ Add photos**: equirectangular 360° images (2:1); auto-shrunk to max 8192 px wide.
- **Add point**: click the picture, name it, choose which photo it opens (or add a new photo). A way back is added by default.
- Click a point to edit/delete/open it. List: ★ start view, ✎ rename, ✕ delete. **Preview** shows the visitor view.
- Everything is saved automatically in *this browser*. **Export all lands (zip)** downloads `tours.zip`.

## Publish
Unzip `tours.zip` and upload the `tours` folder into the `public` folder of the GitHub repo. Site rebuilds in ~1 min.

- One land per link: `https://YOU.github.io/REPO/?p=LAND-SLUG`
- If you published several lands, `https://YOU.github.io/REPO/` shows a picker with all lands.
- Existing published lands are loaded into the editor automatically (from any browser), so you can keep adding to them.

## GitHub Pages workflow
Create `.github/workflows/deploy.yml` in the repo (Add file → Create new file) with the YAML from the chat, then
Settings → Pages → Source = GitHub Actions.

## Run locally (optional)
`npm install`, `npm run dev` (needs Node.js).
