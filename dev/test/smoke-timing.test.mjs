// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createControlPlane } from '../smoke-control.mjs';
import { makePlan } from '../smoke-safety.mjs';
import { sanitizeBridgeValue } from '../smoke-bridge.mjs';
const plan = () => makePlan({runId:'timing-fixture',accountId:'a'.repeat(32),accountName:'Fixture',accountPlan:'Workers Paid',namespace:'heddle-demo',jurisdiction:'unrestricted'});
function fixture(fetchImpl) {
  const p=plan(), ledger={state:{resources:[],pending:[],cleanupFailures:[]},save:async()=>{throw new Error('Telemetry must not save independently');}};
  let clock=100;
  return {plan:p,ledger,control:createControlPlane({plan:p,ledger,apiToken:'SECRET-API',fetchImpl,monotonic:()=>{clock+=12.25;return clock;}})};
}
test('REST timing retains only safe aggregate metadata, no token body or error text',async()=>{
  const f=fixture(async()=>({status:200,ok:true,headers:{get:()=> '123'},json:async()=>({success:true,result:{plaintext:'SECRET-TOKEN'}})}));
  assert.equal((await f.control.api('/artifacts/namespaces/heddle-demo/tokens','POST',{repo:'fixture'})).plaintext,'SECRET-TOKEN');
  assert.deepEqual(f.ledger.state.apiTimings,[{method:'POST',phase:'normal',transport:'direct-rest',operation:'tokens',status:200,outcome:'success',elapsedMs:12.25,contentLengthBytes:123}]);
  assert(!JSON.stringify(f.ledger.state).includes('SECRET'));
  const failed=fixture(async()=>{throw new Error('SECRET-NETWORK-DIAGNOSTIC');});
  await assert.rejects(failed.control.api('/artifacts/namespaces/heddle-demo'));
  assert.equal(failed.ledger.state.apiTimings[0].outcome,'failed');
  assert.equal(failed.ledger.state.apiTimings[0].status,null);
  assert(!JSON.stringify(failed.ledger.state).includes('SECRET'));
});
test('HTTP errors stay failed observations and absent ownership probes are identified',async()=>{
  for (const [status,allow404,outcome] of [[503,false,'failed'],[404,true,'allowed-absent']]) {
    const f=fixture(async()=>({status,ok:false,json:async()=>({success:false,errors:['SECRET']})}));
    if(allow404) assert.equal(await f.control.api('/artifacts/namespaces/heddle-demo/repos/fixture','GET',undefined,true),null);
    else await assert.rejects(f.control.api('/artifacts/namespaces/heddle-demo'));
    assert.equal(f.ledger.state.apiTimings[0].outcome,outcome);
    assert.equal(f.ledger.state.apiTimings[0].status,status);
    assert.equal(f.ledger.state.apiTimings[0].contentLengthBytes,null);
  }
});
test('Queue evidence retains only exact Git OIDs and canonical event timestamp',()=>{
  const p=plan(), before='a'.repeat(40),after='b'.repeat(40),timestamp='2026-10-10T21:00:00.000Z';
  const event={type:'cf.artifacts.repo.pushed',source:{namespace:p.target.namespace,repoName:p.resources.repositories[0]},payload:{ref:'refs/heads/main',before,after,commits:[{message:'SECRET'}]},metadata:{eventTimestamp:timestamp,private:'SECRET'}};
  const normalize=body=>sanitizeBridgeValue('pull',200,{success:true,result:{messages:[{lease_id:'fixture-lease',body}]}},p).result.messages[0].body;
  assert.deepEqual(normalize(event),{type:event.type,source:event.source,payload:{ref:event.payload.ref,before,after},metadata:{eventTimestamp:timestamp}});
  for(const value of [after+'\n','SECRET',null]) assert.throws(()=>normalize({...event,payload:{...event.payload,after:value}}),/bridge_invalid/);
  for(const value of ['SECRET','2026-02-30T21:00:00.000Z',timestamp+'\n']) assert.throws(()=>normalize({...event,metadata:{eventTimestamp:value}}),/bridge_invalid/);
  assert(!JSON.stringify(normalize(event)).includes('SECRET'));
});
