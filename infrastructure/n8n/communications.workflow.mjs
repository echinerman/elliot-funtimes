import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const model = readFileSync(new URL('../../communications-model.mjs', import.meta.url), 'utf8').replace(/^export /gm, '');
const engine = readFileSync(new URL('./communications-db.mjs', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const firebase = { googleApi: { id: 'wuOeUnl3NuRU8gYA', name: 'Firebase - Strong8K Renewals' } };
const gmail = { gmailOAuth2: { id: 'gfmywRSTE0Ksh33Z', name: 'Gmail account' } };
const smtp = { smtp: { id: 'vGz06Qdv8jZrKhLc', name: 'Oracle Email Delivery - info@goelliot.vip' } };
const settings = { executionOrder: 'v1', saveDataSuccessExecution: 'none', saveDataErrorExecution: 'none', saveManualExecutions: false, executionTimeout: 240, timezone: 'America/Toronto' };

export function makeWorkflow(id, name) {
    const nodes = [], connections = {};
    const node = (name, type, parameters, extra = {}) => {
        nodes.push({ id: `${id}-${nodes.length}`, name, type: `n8n-nodes-base.${type}`, typeVersion: { code: 2, httpRequest: 4.2, merge: 3.2, if: 2.2, scheduleTrigger: 1.2, webhook: 2.1, respondToWebhook: 1.4, emailSend: 2.1 }[type] || 1,
            position: [nodes.length % 8 * 240, Math.floor(nodes.length / 8) * 260], parameters, ...extra }); return name;
    };
    const edge = (from, to, output = 0, input = 0) => {
        connections[from] ||= { main: [] }; connections[from].main[output] ||= [];
        connections[from].main[output].push({ node: to, type: 'main', index: input });
    };
    const code = (name, jsCode) => node(name, 'code', { jsCode });
    const condition = (name, expression) => node(name, 'if', { conditions: { options: { typeValidation: 'strict', version: 2 }, conditions: [{ id: name, leftValue: expression, rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' } });
    const http = (name, url, method, body, credential, extra = {}) => node(name, 'httpRequest', {
        url, method, ...(credential ? { authentication: 'predefinedCredentialType', nodeCredentialType: Object.keys(credential)[0] } : {}),
        ...(body ? { sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: body } : {}),
        options: { timeout: 20000, response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } }
    }, { ...(credential ? { credentials: credential } : {}), onError: 'continueRegularOutput', ...extra });
    const schedule = () => node('Every minute', 'scheduleTrigger', { rule: { interval: [{ field: 'minutes', minutesInterval: 1 }] } });
    const db = (prefix, operation, args = '$json') => {
        const init = code(`${prefix} init`, `return [{json:{op:${JSON.stringify(operation)},args:${args},now:Date.now(),id:'comm_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2),history:[]}}];`);
        const step = code(`${prefix} step`, model + '\n' + engine + `
const state=$json;
let cursor=0;
try {
 const result=await runCommunicationOperation(state.op,state.args,{now:state.now,id:state.id,request:async request=>{
   if(cursor<state.history.length) return state.history[cursor++];
   const pending=new Error('REQUEST'); pending.request=request; throw pending;
 }});
 return [{json:{done:true,result}}];
} catch(error) {
 if(error.request) {
  if(state.history.length>100) return [{json:{done:true,result:{ok:false,httpStatus:503,message:'Storage operation exceeded its safety limit.'}}}];
  return [{json:{...state,done:false,request:error.request}}];
 }
 return [{json:{done:true,result:{ok:false,httpStatus:error.status>=400&&error.status<500?error.status:503,message:error.message||'Communication storage unavailable.'}}}];
}`);
        const branch = condition(`${prefix} needs request`, '={{ $json.done === false }}');
        const readBranch = condition(`${prefix} read request`, '={{ $json.request.method === "GET" }}');
        const readRequest = http(`${prefix} Firestore read`, '={{ $json.request.url }}', 'GET', null, firebase);
        const writeRequest = http(`${prefix} Firestore write`, '={{ $json.request.url }}', 'POST', '={{ $json.request.body }}', firebase);
        const merge = node(`${prefix} state and response`, 'merge', { mode: 'combine', combineBy: 'combineByPosition', options: {} });
        const advance = code(`${prefix} record response`, `const {body,statusCode,error,...state}=$json; state.history.push({status:statusCode||503,body:body||{error:{status:'TRANSPORT_ERROR'}}}); delete state.headers; delete state.request; return [{json:state}];`);
        const end = code(`${prefix} result`, 'return [{json:$json.result}];');
        edge(init, step); edge(step, branch); edge(branch, readBranch); edge(branch, merge, 0, 0);
        edge(readBranch, readRequest); edge(readBranch, writeRequest, 1);
        edge(readRequest, merge, 0, 1); edge(writeRequest, merge, 0, 1);
        edge(merge, advance); edge(advance, step); edge(branch, end, 1);
        return { start: init, end };
    };
    return { node, edge, code, condition, http, schedule, db,
        finish: () => ({ id, name, active: false, nodes, connections, settings, staticData: null, pinData: {}, tags: [] }) };
}

export function buildCommunicationWorkflows() {
    const workflows = [];
    {
        const w = makeWorkflow('goelliotSupport20261102', 'Communications - Portal support message');
        const webhook = w.node('Portal support POST', 'webhook', { httpMethod: 'POST', path: 'portal-support-message', responseMode: 'responseNode', options: { allowedOrigins: 'https://goelliot.vip' } }, { webhookId: 'b258d336-2507-4e2a-823d-e816b94302e0' });
        const parse = w.code('Validate input', model + `
try { const raw=typeof $json.body==='string'?JSON.parse($json.body):$json.body; if(!raw||typeof raw.idToken!=='string'||raw.idToken.length>10000) throw new Error('Sign in again.'); return [{json:{ok:true,input:validateSupportInput(raw),idToken:raw.idToken}}]; }
catch(error) { return [{json:{ok:false,httpStatus:400,message:error.message}}]; }`);
        const valid = w.condition('Valid input', '={{ $json.ok === true }}');
        const identity = w.http('Verify Firebase session', 'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=AIzaSyAH5CRCJoktmY6baXshDnOVgylHldcPa3E', 'POST', '={{ { idToken: $json.idToken } }}');
        const op = w.db('Support', 'support', `{input:$('Validate input').first().json.input,identity:$json.body||{}}`);
        const response = w.node('Reply to portal', 'respondToWebhook', { respondWith: 'json', responseBody: '={{ $json }}', options: { responseCode: '={{ $json.httpStatus || ($json.ok ? 201 : 503) }}', responseHeaders: { entries: [
            { name: 'Access-Control-Allow-Origin', value: 'https://goelliot.vip' }, { name: 'Access-Control-Allow-Headers', value: 'Content-Type' },
            { name: 'Cache-Control', value: 'no-store' }, { name: 'Vary', value: 'Origin' }, { name: 'X-Content-Type-Options', value: 'nosniff' }
        ] } } });
        w.edge(webhook, parse); w.edge(parse, valid); w.edge(valid, identity); w.edge(valid, response, 1); w.edge(identity, op.start); w.edge(op.end, response);
        workflows.push(w.finish());
    }
    {
        const w = makeWorkflow('goelliotIngest20261102', 'Communications - Gmail ingestion');
        const trigger = w.schedule(); const config = w.db('Settings', 'settings'); w.edge(trigger, config.start);
        const enabled = w.code('Enabled mailbox', `return $json.ok ? [{json:$json}] : [];`); w.edge(config.end, enabled);
        const labels = w.http('Gmail labels', 'https://gmail.googleapis.com/gmail/v1/users/me/labels', 'GET', null, gmail); w.edge(enabled, labels);
        const select = w.code('Select dedicated labels', `
if($json.statusCode!==200) throw new Error('Gmail labels unavailable. Reauthorize Gmail.');
const config=$('Enabled mailbox').first().json;
const labels=$json.body.labels||[];
const incoming=labels.find(l=>l.name===config.gmail_label);
const processed=labels.find(l=>l.name===config.gmail_processed_label);
if(!incoming||!processed) throw new Error('Create the dedicated goelliot inbox and processed Gmail labels before activation.');
return [{json:{incoming:incoming.id,processed:processed.id,query:'-label:'+config.gmail_processed_label+' -in:spam -in:trash'}}];`); w.edge(labels, select);
        const list = w.http('Next labeled message', '=https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1&labelIds={{ encodeURIComponent($json.incoming) }}&q={{ encodeURIComponent($json.query) }}', 'GET', null, gmail); w.edge(select, list);
        const pick = w.code('Select message', `if($json.statusCode!==200) throw new Error('Gmail search failed.'); const message=$json.body.messages?.[0]; return message?[{json:message}]:[];`); w.edge(list, pick);
        const read = w.http('Read message without attachments', '=https://gmail.googleapis.com/gmail/v1/users/me/messages/{{ $json.id }}?format=full', 'GET', null, gmail); w.edge(pick, read);
        const normalize = w.code('Normalize email', model + `
if($json.statusCode!==200) throw new Error('Gmail message unavailable.');
const message=normalizeGmailMessage($json.body,value=>Buffer.from(value,'base64url').toString('utf8'));
return [{json:{message}}];`); w.edge(read, normalize);
        const ingest = w.db('Ingest', 'ingest'); w.edge(normalize, ingest.start);
        const stored = w.code('Stored or ignored', `if(!$json.ok) throw new Error($json.message||'Message not stored. It will be retried.'); return [{json:$json}];`); w.edge(ingest.end, stored);
        const mark = w.http('Mark processed after durable store', '=https://gmail.googleapis.com/gmail/v1/users/me/messages/{{ $("Select message").first().json.id }}/modify', 'POST', '={{ {addLabelIds:[$("Select dedicated labels").first().json.processed]} }}', gmail); w.edge(stored, mark);
        workflows.push(w.finish());
    }
    {
        const w = makeWorkflow('goelliotOutbox20261102', 'Communications - Oracle reply outbox');
        const trigger = w.schedule(); const claim = w.db('Claim', 'claim_send'); w.edge(trigger, claim.start);
        const claimed = w.code('Claimed email', `if(!$json.ok) throw new Error($json.message||'Outbox claim failed.'); return $json.id?[{json:$json}]:[];`); w.edge(claim.end, claimed);
        const send = w.node('Send through Oracle', 'emailSend', { resource: 'email', operation: 'send', fromEmail: 'goelliot.vip <info@goelliot.vip>', toEmail: '={{ $json.envelope.to }}', subject: '={{ $json.envelope.subject }}', emailFormat: 'text', text: '={{ $json.envelope.body }}', options: { replyTo: '={{ $json.envelope.reply_to }}', appendAttribution: false, allowUnauthorizedCerts: false } }, { credentials: smtp, onError: 'continueRegularOutput', retryOnFail: false }); w.edge(claimed, send);
        const classify = w.code('Classify SMTP outcome', model + `
const result=classifySendResult($json);
result.reference_key=mailReferenceKey(result.provider_message_id);
return [{json:{claim:$('Claimed email').first().json,result}}];`); w.edge(send, classify);
        const finish = w.db('Finish', 'finish_send'); w.edge(classify, finish.start);
        workflows.push(w.finish());
    }
    {
        const w = makeWorkflow('goelliotNotify20261102', 'Communications - Home Assistant alerts');
        const trigger = w.schedule(); const claim = w.db('Claim', 'claim_notice'); w.edge(trigger, claim.start);
        const claimed = w.code('Claimed notification', `if(!$json.ok) throw new Error($json.message||'Notification claim failed.'); if(!$json.id) return []; return [{json:$json}];`); w.edge(claim.end, claimed);
        const valid = w.condition('HA destination configured', '={{ $json.ha_url === "http://100.70.117.124:8123" && /^mobile_app_[a-z0-9_]+$/.test($json.notify_service) }}'); w.edge(claimed, valid);
        const payload = w.code('Prepare phone alert payload', `return [{json:{notify_service:$json.notify_service,payload:{title:'goelliot.vip: new message',message:$json.preview||'A customer message needs attention.',data:{url:'https://goelliot.vip/admin.html#inbox/'+$json.thread_id,clickAction:'https://goelliot.vip/admin.html#inbox/'+$json.thread_id,tag:'goelliot-'+$json.thread_id,visibility:'private'}}}}];`); w.edge(valid, payload);
        const send = w.node('Send Home Assistant alert', 'httpRequest', {
            method: 'POST', url: '=http://100.70.117.124:8123/api/services/notify/{{ $json.notify_service }}', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
            sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: '={{ $json.payload }}',
            options: { timeout: 15000, response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } }
        }, { onError: 'continueRegularOutput', credentials: { httpHeaderAuth: { id: 'goelliotHACommunications20261102', name: 'Home Assistant - Communications' } } }); w.edge(payload, send);
        const classify = w.code('Notification outcome', `return [{json:{claim:$('Claimed notification').first().json,result:{status:$json.statusCode>=200&&$json.statusCode<300?'sent':'failed',error_code:$json.statusCode>=200&&$json.statusCode<300?'':'HA_UNAVAILABLE'}}}];`); w.edge(send, classify);
        const unconfigured = w.code('Missing HA setup', `return [{json:{claim:$json,result:{status:'failed',error_code:'HA_NOT_CONFIGURED'}}}];`); w.edge(valid, unconfigured, 1);
        const finish = w.db('Finish', 'finish_notice'); w.edge(classify, finish.start); w.edge(unconfigured, finish.start);
        workflows.push(w.finish());
    }
    {
        const w = makeWorkflow('goelliotRenewalInbox20261102', 'Communications - Renewal request inbox');
        const trigger = w.schedule(); const op = w.db('Renewal', 'renewals'); w.edge(trigger, op.start); workflows.push(w.finish());
    }
    return workflows;
}

export function buildCommunicationStorageCheck() {
    const w = makeWorkflow('goelliotCommStorageCheck20261102', 'Communications - Storage readiness (read only)');
    const trigger = w.node('Manual read-only check', 'manualTrigger', {});
    const check = w.db('Storage', 'storage_check'); w.edge(trigger, check.start);
    return w.finish();
}

export function buildCommunicationSetup() {
    const w = makeWorkflow('goelliotCommSetup20261102', 'Communications - Initialize disabled settings');
    const trigger = w.node('Manual setup', 'manualTrigger', {});
    const setup = w.db('Setup', 'initialize'); w.edge(trigger, setup.start);
    return w.finish();
}

export function buildCommunicationMailboxCheck() {
    const w = makeWorkflow('goelliotCommMailboxCheck20261103', 'Communications - Gmail readiness (read only)');
    const trigger = w.node('Manual mailbox check', 'manualTrigger', {});
    const profile = w.http('Read Gmail account identity', 'https://gmail.googleapis.com/gmail/v1/users/me/profile', 'GET', null, gmail);
    const verify = w.code('Verify intended mailbox', `if($json.statusCode!==200) throw new Error('Gmail identity check failed. Reauthorize the Gmail credential.'); const email=String($json.body?.emailAddress||'').toLowerCase(); if(email!=='e.chinerman@gmail.com') throw new Error('Gmail credential is for '+email+', not the intended mailbox.'); return [{json:{email}}];`);
    const labels = w.http('Read mailbox labels', 'https://gmail.googleapis.com/gmail/v1/users/me/labels', 'GET', null, gmail);
    const result = w.code('Mailbox readiness result', `if($json.statusCode!==200) throw new Error('Gmail labels could not be read.'); const names=($json.body.labels||[]).map(label=>label.name); return [{json:{ok:true,account_email:$('Verify intended mailbox').first().json.email,incoming_label_ready:names.includes('goelliot-inbox'),processed_label_ready:names.includes('goelliot-processed')}}];`);
    w.edge(trigger, profile); w.edge(profile, verify); w.edge(verify, labels); w.edge(labels, result);
    return w.finish();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.stdout.write(JSON.stringify([...buildCommunicationWorkflows(), buildCommunicationStorageCheck(), buildCommunicationSetup(), buildCommunicationMailboxCheck()]));
