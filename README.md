# ImageTools

Product-photo tools that run on **your ChatGPT + Claude subscriptions**, fully on a server:

| Tool | Input | Output |
|---|---|---|
| **Multi-angle** | 1 product photo | Same product from the angles you pick (front, 45°, side, back, top, detail) |
| **Apply fabric** | Furniture photo + fabric photo | Furniture upholstered in that fabric |
| **Restyle** | Furniture photo | Same furniture with new fabric / color / wood-metal polish |
| **Drawing** | 1+ product photos | Claude writes a drawing prompt (instructions editable in the UI), ChatGPT draws it |

After every job the ChatGPT / Claude chat is deleted so history and the image library don't fill up.

## How it works

```
Browser ──HTTPS──▶ Cloudflare tunnel ──▶ Node server (UI + job queue)
                                            ▲ 127.0.0.1 only
                                            │
                     Chromium (virtual screen) + ImageTools extension ──▶ chatgpt.com + claude.ai (your logins)
```

- `server/` – zero-dependency Node server. `tools.js` holds the tools and their prompts — add a tool there and the UI picks it up automatically.
- `extension/` – Chrome extension that takes jobs and runs them in the ChatGPT tab (uploads images, sends prompts, saves results).
- `public/` – web UI. Remote browser view (noVNC) at the status pill, protected by the same password.

## Deploy (free: Oracle Cloud Always Free, Ubuntu VM)

```bash
curl -fsSL https://raw.githubusercontent.com/syedfaisaljaved/Imagetoools-clause/ccr-bd2b5ca2-gqivhg/deploy/install.sh | bash
```

It prints the app URL + password. Open it, click a status pill (top-right) and log in to ChatGPT and Claude once (one window each). Re-run the same command to update.

Public URL again: `cd ~/imagetools && sudo docker compose logs tunnel | grep trycloudflare`

## Develop

```bash
APP_PASSWORD=pw npm start   # http://localhost:8080
npm test                    # unit + browser e2e (needs Playwright for the browser tests)
```
