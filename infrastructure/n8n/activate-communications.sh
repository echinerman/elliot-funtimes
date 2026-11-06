#!/usr/bin/env bash
set -euo pipefail
umask 077
for workflow in goelliotSupport20261102 goelliotIngest20261102 goelliotOutbox20261102 goelliotNotify20261102 goelliotRenewalInbox20261102; do
  sudo docker exec n8n n8n publish:workflow --id="$workflow"
done
sudo docker restart n8n
sudo docker exec -e N8N_RUNNERS_BROKER_PORT=5689 n8n n8n execute --id=goelliotCommActivate20261103 --rawOutput > /tmp/goelliot-live-activation-result.json
python3 - <<'PY'
import json
from pathlib import Path
path = Path('/tmp/goelliot-live-activation-result.json')
text = path.read_text()
execution = json.loads(text[text.index('{'):])
result = execution['data']['resultData']['runData']['Verify live runtime'][-1]['data']['main'][0][0]['json']
if result != {'ok': True, 'enabled': True, 'sending_enabled': True, 'notifications_enabled': True}:
    raise SystemExit('Live runtime was not verified.')
print(json.dumps(result))
path.unlink()
PY
