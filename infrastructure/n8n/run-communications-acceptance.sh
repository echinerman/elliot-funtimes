#!/usr/bin/env bash
set -euo pipefail
umask 077
run_check() {
  sudo docker exec -e N8N_RUNNERS_BROKER_PORT=5689 n8n n8n execute --id="$1" --rawOutput > "/tmp/$1-result.json"
}
cleanup() {
  run_check goelliotCommAcceptanceStop20261103 || printf '%s\n' 'ERROR: Runtime reset failed. Manually disable all messaging flags.' >&2
  python3 - <<'PY'
import json
from pathlib import Path
for identifier in ['goelliotCommAcceptanceSeed20261103', 'goelliotCommAcceptanceResume20261103', 'goelliotCommAcceptanceSend20261103', 'goelliotCommAcceptanceIngest20261103', 'goelliotCommAcceptanceStop20261103']:
    path = Path('/tmp') / (identifier + '-result.json')
    if not path.exists():
        continue
    try:
        text = path.read_text()
        execution = None
        decoder = json.JSONDecoder()
        for index, character in enumerate(text):
            if character != '{':
                continue
            try:
                candidate, _ = decoder.raw_decode(text[index:])
            except ValueError:
                continue
            if isinstance(candidate, dict) and 'resultData' in candidate.get('data', {}):
                execution = candidate
                break
        if execution is None:
            raise ValueError('No execution result was returned for ' + identifier)
        result = execution.get('data', {}).get('resultData', {})
        last = result.get('lastNodeExecuted')
        rows = result.get('runData', {}).get(last, [])
        data = rows[-1].get('data', {}).get('main', [[]])[0] if rows else []
        final = data[0].get('json', {}) if data else {}
        safe = {key: value for key, value in final.items() if key in ['ok', 'status', 'threadId', 'test_thread', 'enabled', 'sending_enabled', 'notifications_enabled', 'httpStatus', 'duplicate']}
        http_errors = []
        for node_name, node_runs in result.get('runData', {}).items():
            if 'Firestore' not in node_name:
                continue
            for node_run in node_runs:
                items = node_run.get('data', {}).get('main', [[]])[0]
                value = items[0].get('json', {}) if items else {}
                if value.get('statusCode', 0) >= 400:
                    api_error = value.get('body', {}).get('error', {})
                    http_errors.append({'node': node_name, 'status': value.get('statusCode'), 'code': api_error.get('status'), 'message': str(api_error.get('message', ''))[:250]})
        print(json.dumps({'workflow': identifier, 'status': execution.get('status'), 'last_node': last, 'result': safe, 'error': result.get('error', {}).get('message'), 'storage_errors': http_errors}))
    finally:
        path.unlink(missing_ok=True)
PY
}
trap cleanup EXIT
if [[ "${1:-}" == ingest ]]; then
  run_check goelliotCommAcceptanceResume20261103
  run_check goelliotCommAcceptanceIngest20261103
  exit 0
elif [[ "${1:-}" == resume ]]; then
  run_check goelliotCommAcceptanceResume20261103
else
  run_check goelliotCommAcceptanceSeed20261103
fi
run_check goelliotCommAcceptanceSend20261103
run_check goelliotCommAcceptanceIngest20261103
