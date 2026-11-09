/* Deterministic UI grading acceptance. Run with NODE_PATH pointing to an existing
   playwright-core installation and BENCH_E2E_BASE to an isolated local server. */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
require('module').Module._initPaths();
const {chromium} = require('playwright-core');
const base=process.env.BENCH_E2E_BASE || 'http://127.0.0.1:8092';
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN});
const page=await browser.newPage({viewport:{width:1280,height:900}});
const errors=[];
page.on('pageerror', e=>errors.push(e.message));
page.on('console', m=>{if(m.type()==='error') errors.push(m.text());});
page.on('requestfailed', r=>{
  if(r.url().endsWith('/events') && r.failure()?.errorText==='net::ERR_ABORTED') return; // terminal run closes its watcher
  errors.push(`${r.url()}: ${r.failure()?.errorText}`);
});
const categories=['Coding','Engineering','Logic','Knowledge','Instructions','Context','Writing'];
function makeRun(id,perfect=false,legacy=false) {
  const results=categories.filter(c=>c!=='Writing').map(category=>({endpoint:'Fixture',model:'fixture-model',category,question:'Fixture question',response:'2',score:1,status:'ok',reason:null,elapsed:1,tokens:null}));
  if(!perfect) results[0]={...results[0],score:null,response:'def solve(): return solve()',reason:'Limited static evaluation: recursion is unsupported.'};
  if(!perfect) results.push({...results[0],category:'Engineering',status:'incomplete',reason:'Completion stopped at the token limit; partial output was not graded.',response:'20'});
  if(!perfect) results.push({...results[0],category:'Knowledge',status:'error',reason:'Connection failed.',response:''});
  const summary=categories.map(category=>{
    const rows=results.filter(r=>r.category===category), graded=rows.filter(r=>r.score!==null);
    return {endpoint:'Fixture',model:'fixture-model',category,score:graded.length?100:null,coverage:graded.length,total:rows.length,ungraded:rows.length-graded.length,elapsed:rows.length,tokens:0};
  });
  return {id,created:'2026-11-10T00:00:00Z',depth:'Quick',state:'completed',models:[{endpoint:'Fixture',model:'fixture-model'}],categories,results,summary,progress:results.length,total:results.length,composites:perfect?{'Fixture/fixture-model':100}:{},complete:perfect,grader_version:legacy?'legacy':'2',task_policy_version:'1',events:[],error:null};
}
const runs=[makeRun('partial'),makeRun('perfect',true),makeRun('legacy',true,true)];
const seen=[];
await page.route('**/api/**',async route=>{
 const p=new URL(route.request().url()).pathname; seen.push(p);
 if(p.endsWith('/events')) return route.fulfill({contentType:'text/event-stream',body:'event: progress\ndata: {"state":"completed"}\n\n'});
 let body;
 if(p==='/api/health') body={status:'ok'};
 else if(p==='/api/runs') body=runs;
 else if(p.startsWith('/api/runs/')) body=runs.find(r=>p===`/api/runs/${r.id}`);
 else if(p==='/api/bench/setup') body=null;
 else if(p==='/api/bench') body={models:[]};
 else if(p==='/api/datasets') body=[];
 else if(p==='/api/lab/setup') body=null;
 else if(p.startsWith('/api/references')) body={state:'not_configured',rows:[]};
 if(body===undefined) throw Error(`Unexpected API request ${p}`);
 await route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
});
try {
 await page.goto(`${base}/#run/partial`);
 await page.getByText('No complete composite',{exact:true}).waitFor();
 assert.match(await page.locator('table.scores').innerText(),/Ungraded/);
 assert.match(await page.locator('table.scores').innerText(),/1 of 2 graded/);
 await page.locator('[data-attempt="0"]').click();
 await page.getByText('Limited static evaluation: recursion is unsupported.',{exact:true}).waitFor();
 await page.locator('[data-attempt="6"]').click();
 assert.match(await page.locator('.verdict').innerText(),/Incomplete/);
 await page.getByText('Completion stopped at the token limit; partial output was not graded.',{exact:true}).waitFor();
 await page.getByRole('link',{name:'Compare',exact:true}).click();
 await page.getByText('Partial, not a composite',{exact:true}).waitFor();
 assert.match(await page.locator('.chart-desc').innerText(),/partial/);
 await page.reload();
 await page.getByText('Partial, not a composite',{exact:true}).waitFor();
 await page.goto(`${base}/#run/perfect`);
 await page.getByRole('columnheader',{name:'Composite',exact:true}).waitFor();
 assert.match(await page.locator('table.scores').innerText(),/100/);
 await page.goto(`${base}/#run/legacy`);
 await page.getByText(/Legacy grader: historical results are preserved/).waitFor();
 for(const width of [390,768]) {
  await page.setViewportSize({width,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`page fits ${width}px`);
  await page.getByRole('button',{name:'Previous',exact:true}).click();
  await page.getByRole('link',{name:'Runs',exact:true}).click();
  await page.getByRole('heading',{name:'Run history',exact:true}).waitFor();
  await page.goto(`${base}/#run/partial`);
  await page.getByText('No complete composite',{exact:true}).waitFor();
 }
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,assertions:'explanations, incomplete verdict, coverage, partial chart labels, refresh, perfect composite, legacy label, navigation, mobile layout',consoleErrors:errors,unexpectedNetworkFailures:errors,apiRoutes:[...new Set(seen)]},null,2));
} catch(error) { console.error(await page.locator('body').innerText(), errors); throw error; } finally {await browser.close();}
