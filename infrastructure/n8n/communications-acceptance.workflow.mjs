import { buildCommunicationWorkflows, makeWorkflow } from './communications.workflow.mjs';

// Manual, single-recipient acceptance helpers. Never publish these as scheduled workers.
export function buildAcceptanceWorkflows(gmailMessageId) {
    if (!/^[a-f0-9]{8,64}$/.test(gmailMessageId)) throw new Error('A specific test Gmail message ID is required.');
    const threadId = 'comm_setup_20261103';
    const messageId = 'acceptance_reply_20261103A';
    const root = 'projects/elliotvip/databases/(default)/documents';
    const base = `https://firestore.googleapis.com/v1/${root}`;
    const firebase = { googleApi: { id: 'wuOeUnl3NuRU8gYA', name: 'Firebase - Strong8K Renewals' } };
    const seed = makeWorkflow('goelliotCommAcceptanceSeed20261103', 'Communications - Acceptance seed (Elliot only)');
    const start = seed.node('Manual acceptance setup', 'manualTrigger', {});
    const runtime = seed.http('Read disabled runtime', `${base}/communication_config/runtime`, 'GET', null, firebase);
    const query = seed.http('Require an empty outbox', base + ':runQuery', 'POST', JSON.stringify({ structuredQuery: { from: [{ collectionId: 'communication_outbox' }], limit: 1 } }), firebase);
    const prepare = seed.code('Prepare isolated acceptance records', `
const response=$('Read disabled runtime').first().json;
const config=response.body;
if(response.statusCode!==200||!config?.updateTime||['enabled','sending_enabled','notifications_enabled'].some(key=>config.fields?.[key]?.booleanValue!==false)) throw new Error('Acceptance requires all runtime flags off.');
if($json.statusCode!==200||!Array.isArray($json.body)||$json.body.some(row=>row.document)) throw new Error('Acceptance requires an empty outbox.');
const now=new Date().toISOString();
const fields=object=>Object.fromEntries(Object.entries(object).map(([key,value])=>[key,typeof value==='boolean'?{booleanValue:value}:typeof value==='number'?{integerValue:String(value)}:{stringValue:String(value)}]));
const create=(path,data)=>({update:{name:${JSON.stringify(root)}+'/'+path,fields:fields(data)},currentDocument:{exists:false}});
const body='Controlled communications acceptance test for Elliot only. This reply was queued and sent through the production outbox logic using Oracle SMTP. No customer record or subscription was changed.';
return [{json:{writes:[
{update:{name:config.name,fields:fields({enabled:true,sending_enabled:true,notifications_enabled:false,acceptance_session:${JSON.stringify(threadId)}})},updateMask:{fieldPaths:['enabled','sending_enabled','notifications_enabled','acceptance_session']},currentDocument:{updateTime:config.updateTime}},
create('communication_threads/${threadId}',{subject:'[SETUP TEST] Inbox routing 20261103-A',participant_email:'e.chinerman@gmail.com',account_id:'',license_id:'',status:'open',source:'acceptance_test',category:'support',created_at:now,updated_at:now,last_message_at:now,last_inbound_id:'',last_read_inbound_id:'',preview:'Controlled setup test for Elliot only.'}),
create('communication_threads/${threadId}/messages/${messageId}',{direction:'outbound',source:'acceptance_test',sender_email:'info@goelliot.vip',to_email:'e.chinerman@gmail.com',body,status:'queued',created_by:'controlled_acceptance',created_at:now,updated_at:now}),
create('communication_outbox/${messageId}',{thread_id:${JSON.stringify(threadId)},to_email:'e.chinerman@gmail.com',body,status:'queued',attempts:0,created_by:'controlled_acceptance',created_at:now,updated_at:now})]}}];`);
    const commit = seed.http('Create test records atomically', base + ':commit', 'POST', '={{ $json }}', firebase);
    const complete = seed.code('Verify acceptance setup', `if($json.statusCode!==200) throw new Error('Acceptance setup was not committed. Do not send.'); return [{json:{ok:true,test_thread:${JSON.stringify(threadId)}}}];`);
    seed.edge(start, runtime); seed.edge(runtime, query); seed.edge(query, prepare); seed.edge(prepare, commit); seed.edge(commit, complete);

    const outbox = structuredClone(buildCommunicationWorkflows().find(workflow => workflow.id === 'goelliotOutbox20261102'));
    outbox.id = 'goelliotCommAcceptanceSend20261103'; outbox.name = 'Communications - Acceptance outbox (Elliot only)';
    Object.assign(outbox.nodes.find(node => node.name === 'Every minute'), { type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} });
    outbox.nodes.find(node => node.name === 'Claimed email').parameters.jsCode = `if($json.id&&($json.id!==${JSON.stringify(messageId)}||$json.envelope?.to!=='e.chinerman@gmail.com')) throw new Error('Refusing to send anything except the controlled Elliot test.');\n` + outbox.nodes.find(node => node.name === 'Claimed email').parameters.jsCode;

    const inbound = structuredClone(buildCommunicationWorkflows().find(workflow => workflow.id === 'goelliotIngest20261102'));
    inbound.id = 'goelliotCommAcceptanceIngest20261103'; inbound.name = 'Communications - Acceptance ingestion (one test only)';
    Object.assign(inbound.nodes.find(node => node.name === 'Every minute'), { type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} });
    inbound.nodes.find(node => node.name === 'Next labeled message').parameters.url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${gmailMessageId}?format=minimal`;
    inbound.nodes.find(node => node.name === 'Select message').parameters.jsCode = `if($json.statusCode!==200||$json.body?.id!==${JSON.stringify(gmailMessageId)}||!$json.body.labelIds?.includes($('Select dedicated labels').first().json.incoming)) throw new Error('The specific labeled acceptance message is unavailable.'); return [{json:{id:$json.body.id}}];`;
    const normalize = inbound.nodes.find(node => node.name === 'Normalize email');
    normalize.parameters.jsCode = `const headers=$json.body?.payload?.headers||[]; const received=headers.filter(header=>header.name.toLowerCase()==='received').map(header=>header.value).join(' '); if(!$json.body?.labelIds?.includes('INBOX')&&!/cloudflare/i.test(received)) throw new Error('Only a Sent copy is visible; Cloudflare delivery is not yet proven.');\n` + normalize.parameters.jsCode;

    const stop = makeWorkflow('goelliotCommAcceptanceStop20261103', 'Communications - Stop acceptance and disable runtime');
    const stopStart = stop.node('Manual acceptance stop', 'manualTrigger', {});
    const stopRead = stop.http('Read acceptance ownership', `${base}/communication_config/runtime`, 'GET', null, firebase);
    const stopGuard = stop.code('Protect unrelated live activation', `if(![200,404].includes($json.statusCode)) throw new Error('Runtime could not be checked.'); const fields=$json.body?.fields||{}; const active=['enabled','sending_enabled','notifications_enabled'].some(key=>fields[key]?.booleanValue===true); if(active&&fields.acceptance_session?.stringValue!==${JSON.stringify(threadId)}) throw new Error('Refusing to disable a live runtime outside this acceptance session.'); return [{json:{fields:{enabled:{booleanValue:false},sending_enabled:{booleanValue:false},notifications_enabled:{booleanValue:false},acceptance_session:{stringValue:''}}}}];`);
    const stopRequest = stop.http('Disable all messaging runtime flags', `${base}/communication_config/runtime?updateMask.fieldPaths=enabled&updateMask.fieldPaths=sending_enabled&updateMask.fieldPaths=notifications_enabled&updateMask.fieldPaths=acceptance_session`, 'PATCH', '={{ $json }}', firebase);
    const stopped = stop.code('Verify disabled runtime', `if($json.statusCode!==200||['enabled','sending_enabled','notifications_enabled'].some(key=>$json.body?.fields?.[key]?.booleanValue!==false)) throw new Error('Runtime reset could not be verified. Disable all three flags in Firestore immediately.'); return [{json:{ok:true,enabled:false,sending_enabled:false,notifications_enabled:false}}];`);
    stop.edge(stopStart, stopRead); stop.edge(stopRead, stopGuard); stop.edge(stopGuard, stopRequest); stop.edge(stopRequest, stopped);
    const resume = makeWorkflow('goelliotCommAcceptanceResume20261103', 'Communications - Resume queued Elliot acceptance test');
    const resumeStart = resume.node('Manual acceptance resume', 'manualTrigger', {});
    const checkRuntime = resume.http('Require disabled runtime', `${base}/communication_config/runtime`, 'GET', null, firebase);
    const checkMessage = resume.http('Read only the queued acceptance email', `${base}/communication_outbox/${messageId}`, 'GET', null, firebase);
    const guard = resume.code('Guard acceptance resume', `const runtime=$('Require disabled runtime').first().json; if(runtime.statusCode!==200||['enabled','sending_enabled','notifications_enabled'].some(key=>runtime.body?.fields?.[key]?.booleanValue!==false)) throw new Error('Runtime must be disabled before resuming.'); const fields=$json.body?.fields; if($json.statusCode!==200||fields?.to_email?.stringValue!=='e.chinerman@gmail.com'||fields?.created_by?.stringValue!=='controlled_acceptance'||!['queued','sent'].includes(fields?.status?.stringValue)) throw new Error('Only the unchanged queued or sent Elliot acceptance fixture may resume.'); return [{json:{fields:{enabled:{booleanValue:true},sending_enabled:{booleanValue:fields.status.stringValue==='queued'},notifications_enabled:{booleanValue:false},acceptance_session:{stringValue:${JSON.stringify(threadId)}}}}}];`);
    const resumeRequest = resume.http('Enable manual acceptance window', `${base}/communication_config/runtime?updateMask.fieldPaths=enabled&updateMask.fieldPaths=sending_enabled&updateMask.fieldPaths=notifications_enabled&updateMask.fieldPaths=acceptance_session&currentDocument.exists=true`, 'PATCH', '={{ $json }}', firebase);
    const resumed = resume.code('Verify acceptance window', `if($json.statusCode!==200||$json.body?.fields?.enabled?.booleanValue!==true||$json.body?.fields?.notifications_enabled?.booleanValue!==false) throw new Error('Acceptance window could not be enabled.'); return [{json:{ok:true,sending_enabled:$json.body.fields.sending_enabled.booleanValue}}];`);
    resume.edge(resumeStart, checkRuntime); resume.edge(checkRuntime, checkMessage); resume.edge(checkMessage, guard); resume.edge(guard, resumeRequest); resume.edge(resumeRequest, resumed);
    const activate = makeWorkflow('goelliotCommActivate20261103', 'Communications - Activate after verified acceptance');
    const activateStart = activate.node('Manual verified activation', 'manualTrigger', {});
    const configCheck = activate.http('Read runtime before activation', `${base}/communication_config/runtime`, 'GET', null, firebase);
    const sentCheck = activate.http('Verify accepted setup reply', `${base}/communication_outbox/${messageId}`, 'GET', null, firebase);
    const inboundCheck = activate.http('Verify durable external test', `${base}/communication_ingest/gmail_${gmailMessageId}`, 'GET', null, firebase);
    const activationGuard = activate.code('Require verified acceptance evidence', `const config=$('Read runtime before activation').first().json; const sent=$('Verify accepted setup reply').first().json; if(config.statusCode!==200||['enabled','sending_enabled','notifications_enabled'].some(key=>config.body?.fields?.[key]?.booleanValue!==false)) throw new Error('All runtime flags must be off before initial activation.'); if(sent.statusCode!==200||sent.body?.fields?.status?.stringValue!=='sent'||sent.body?.fields?.to_email?.stringValue!=='e.chinerman@gmail.com'||!sent.body?.fields?.provider_message_id?.stringValue) throw new Error('The controlled outbound test is not verified.'); if($json.statusCode!==200||!$json.body?.fields?.thread_id?.stringValue) throw new Error('The external test was not durably ingested.'); const fields=config.body.fields; if(fields.ha_url?.stringValue!=='http://100.70.117.124:8123'||fields.ha_notify_service?.stringValue!=='mobile_app_elliot_s_s24'||fields.gmail_label?.stringValue!=='goelliot-inbox'||fields.gmail_processed_label?.stringValue!=='goelliot-processed') throw new Error('Runtime destinations are not the tested values.'); return [{json:{fields:{enabled:{booleanValue:true},sending_enabled:{booleanValue:true},notifications_enabled:{booleanValue:true},acceptance_session:{stringValue:''}}}}];`);
    const activationWrite = activate.http('Enable verified communications runtime', `${base}/communication_config/runtime?updateMask.fieldPaths=enabled&updateMask.fieldPaths=sending_enabled&updateMask.fieldPaths=notifications_enabled&updateMask.fieldPaths=acceptance_session&currentDocument.exists=true`, 'PATCH', '={{ $json }}', firebase);
    const activated = activate.code('Verify live runtime', `if($json.statusCode!==200||['enabled','sending_enabled','notifications_enabled'].some(key=>$json.body?.fields?.[key]?.booleanValue!==true)) throw new Error('Live runtime could not be verified.'); return [{json:{ok:true,enabled:true,sending_enabled:true,notifications_enabled:true}}];`);
    activate.edge(activateStart, configCheck); activate.edge(configCheck, sentCheck); activate.edge(sentCheck, inboundCheck); activate.edge(inboundCheck, activationGuard); activate.edge(activationGuard, activationWrite); activate.edge(activationWrite, activated);
    return [seed.finish(), outbox, inbound, stop.finish(), resume.finish(), activate.finish()];
}

export function buildCommunicationStatusCheck(threadId) {
    if (!/^[a-zA-Z0-9_-]{16,80}$/.test(threadId)) throw new Error('A specific conversation ID is required.');
    const w = makeWorkflow('goelliotCommStatus20261103', 'Communications - Read-only rollout status');
    const base = 'https://firestore.googleapis.com/v1/projects/elliotvip/databases/(default)/documents';
    const firebase = { googleApi: { id: 'wuOeUnl3NuRU8gYA', name: 'Firebase - Strong8K Renewals' } };
    const start = w.node('Manual read-only status', 'manualTrigger', {});
    const config = w.http('Read runtime flags only', base + '/communication_config/runtime', 'GET', null, firebase);
    const thread = w.http('Read selected test conversation', base + '/communication_threads/' + threadId, 'GET', null, firebase);
    const result = w.code('Rollout status result', `const runtime=$('Read runtime flags only').first().json; if(runtime.statusCode!==200||$json.statusCode!==200) throw new Error('Rollout status could not be read.'); const fields=$json.body.fields; return [{json:{enabled:runtime.body.fields.enabled.booleanValue,sending_enabled:runtime.body.fields.sending_enabled.booleanValue,notifications_enabled:runtime.body.fields.notifications_enabled.booleanValue,notification_status:fields.notification_status?.stringValue||'',notification_error:fields.notification_error?.stringValue||'',thread_status:fields.status?.stringValue||''}}];`);
    w.edge(start, config); w.edge(config, thread); w.edge(thread, result);
    return w.finish();
}
