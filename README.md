# gcp — Claude Code plugin

Lets Claude operate Google Cloud through the real `gcloud`, `bq` and `gsutil` CLIs — everything those CLIs can do.

## Install
```
/plugin marketplace add hieuit095/gcp-claude-plugin
/plugin install gcp@gcp-tools
```
Local test: `claude --plugin-dir /path/to/gcp-plugin`

## Requirements
- Google Cloud SDK on PATH (`gcloud`, `bq`, `gsutil`) — https://cloud.google.com/sdk/docs/install
- Node 18+ (no npm install)

## Login with Google
Ask Claude: "log in to Google Cloud" → `gcloud_login` opens Google's sign-in page in your browser. Add "and ADC" for Application Default Credentials. Credentials stay in gcloud's own store; the plugin never sees or stores tokens.
Headless/remote: run `gcloud auth login --no-launch-browser` in your own terminal.

## Safety
| Command type | Behavior |
|---|---|
| read (list/describe/get...) | runs immediately, JSON output |
| create/update/delete/deploy... | refused until Claude re-calls with `confirm=true` after you approve |
| print tokens / read secrets / create keys | blocked (`GCP_ALLOW_SECRET_OUTPUT=1` to allow) |

Set `GCP_READ_ONLY=1` to forbid all writes. Claude Code's own tool-permission prompts still apply on top.

## Tools
`gcloud`, `bq`, `gsutil` (run any command), `gcloud_auth_status`, `gcloud_login`, `gcloud_set_project`, `gcloud_list_projects`, `gcloud_help`.

## License
MIT — see [LICENSE](LICENSE).
