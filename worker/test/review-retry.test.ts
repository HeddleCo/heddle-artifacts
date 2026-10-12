// SPDX-License-Identifier: Apache-2.0
import { it, expect } from 'vitest';
import { SELF, env as testEnv, runInDurableObject, evictDurableObject } from 'cloudflare:test';
import type { Env } from '../env';
const env = testEnv as unknown as Env;
async function api(path: string, body?: any, token = 'test-operator') {
 const response = await SELF.fetch(`https://heddle.test${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
 return new Response(await response.arrayBuffer(), {status: response.status, headers: response.headers});
}
async function fixture() {
 const id = `retry-${crypto.randomUUID().slice(0,8)}`, base = `/api/projects/${id}`, task = `${base}/tasks/escape`;
 for (const [path,body] of [['/api/projects',{id,seed:{template:'demo'}}],[`${base}/tasks`,{slug:'escape',intent:'escape test'}],[`${task}/agents`,{id:'reviewer',kind:'reviewer',displayName:'Reviewer'}]] as const) { const r=await api(path,body);expect(r.status,await r.text()).toBe(200); }
 const project = env.PROJECT.getByName(id);
 const heads = ['hs-a','hs-b'];
 const fallback = { summary:'Unavailable',perCandidate:[{agent:'a',verdict:'concerns',notes:'Unavailable'},{agent:'b',verdict:'concerns',notes:'Unavailable'}],model:'fallback' };
 await runInDurableObject(project, async instance => {
   for(const [i,agent] of ['a','b'].entries()) instance.store.put('candidates',`escape/${agent}`,{task:'escape',agent,state:heads[i],sourceSha:String(i+1).repeat(40),conflicts:[],tests:{status:'pass',summary:'pass'}});
   await instance.engine.mutate('discuss',{opId:'first-review',task:'escape',author:'reviewer',body:JSON.stringify(fallback)},{review:fallback});
   instance.store.storage.sql.exec('DELETE FROM meta WHERE key=?','reviewDue:escape');
 });
 const before = await (await api(task)).json() as any;
 return {project,task,heads,body:{expectHeads:heads,priorTurn:before.turns[0].id},before};
}
it('one reserved retry appends one native turn and duplicate requests never infer again', async()=>{
 const f=await fixture();
 const requests=await Promise.all([api(`${f.task}/review/retry`,f.body),api(`${f.task}/review/retry`,f.body)]);
 for(const r of requests) expect(r.status,await r.clone().text()).toBe(200);
 const after=await (await api(f.task)).json() as any;
 expect(after.turns).toHaveLength(2);expect(after.turns[0]).toEqual(f.before.turns[0]);expect(after.decision).toBeUndefined();
 await runInDurableObject(f.project,instance=>{
   const ops=instance.store.rows<any>("SELECT * FROM ops WHERE command='discuss'");expect(ops).toHaveLength(2);
   const retry=instance.store.get<any>('meta','reviewRetry:escape');expect(retry.status).toBe('completed');
   expect(ops.some(op=>op.id.startsWith('review-retry:escape:'))).toBe(true);
 });
 await evictDurableObject(f.project);
 expect((await api(`${f.task}/review/retry`,f.body)).status).toBe(200);
 expect((await (await api(f.task)).json() as any).turns).toHaveLength(2);
});
it('authorization, exact heads, prior fallback, pending work and decided gates fail closed',async()=>{
 const f=await fixture();
 expect((await api(`${f.task}/review/retry`,f.body,'bad')).status).toBe(403);
 expect((await api(`${f.task}/review/retry`,{...f.body,expectHeads:['hs-stale']})).status).toBe(409);
 expect((await api(`${f.task}/review/retry`,{...f.body,priorTurn:'wrong'})).status).toBe(409);
 await runInDurableObject(f.project,instance=>instance.store.put('meta','reviewDue:escape',Date.now()+60000));
 expect((await api(`${f.task}/review/retry`,f.body)).status).toBe(409);
 await runInDurableObject(f.project,instance=>{instance.store.storage.sql.exec('DELETE FROM meta WHERE key=?','reviewDue:escape');instance.store.put('tasks','escape',{...instance.store.get<any>('tasks','escape'),status:'decided'});});
 expect((await api(`${f.task}/review/retry`,f.body)).status).toBe(409);
});
it('an interrupted reserved request remains consumed after eviction without a second inference',async()=>{
 const f=await fixture();
 await runInDurableObject(f.project,instance=>{instance.store.put('meta','reviewRetry:escape',{priorTurn:f.body.priorTurn,heads:f.heads,status:'reserved'});});
 await evictDurableObject(f.project);
 const response=await api(`${f.task}/review/retry`,f.body);expect(response.status).toBe(200);
 expect((await response.json() as any).retry.status).toBe('reserved');
 expect((await (await api(f.task)).json() as any).turns).toHaveLength(1);
});
