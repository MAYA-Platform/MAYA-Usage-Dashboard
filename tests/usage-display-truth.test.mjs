import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../public/usage-dashboard-public.html', import.meta.url), 'utf8');
const start=html.indexOf('<script>')+8, end=html.indexOf('</script>',start);
assert.ok(start>=8 && end>start);
const source=html.slice(start,end).replace(/refreshAll\(\);\s*setInterval\(refreshAll,\s*60000\);/, '');
const browser={document:{getElementById:()=>({})},Date,Object,String,Number,Math,Array};
vm.runInNewContext(source,browser);
const text=(s)=>s.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();

test('unmeasured totals and projections do not render as zero dollars',()=>{
 const view=text(browser.renderBurnCard({providers:[],totalDailyBurn:0,totalBalance:0,weeklyBurn:0,monthlyBurn:0,runwayDays:null}));
 assert.match(view,/Daily burn\s+—/);
 assert.match(view,/Weekly projection\s+—/);
 assert.match(view,/Monthly projection\s+—/);
 assert.match(view,/Known balance\s+—/);
});

test('an observed zero balance remains zero while burn is unavailable',()=>{
 const view=text(browser.renderBurnCard({providers:[{provider:'sample',lastBalance:0,dailyBurn:null}],totalDailyBurn:0,totalBalance:0,weeklyBurn:0,monthlyBurn:0,runwayDays:null}));
 assert.match(view,/Daily burn\s+—/);
 assert.match(view,/Known balance\s+\$0\.00/);
});

test('measured burn and projections remain visible',()=>{
 const view=text(browser.renderBurnCard({providers:[{provider:'sample',lastBalance:5,dailyBurn:1.25}],totalDailyBurn:1.25,totalBalance:5,weeklyBurn:8.75,monthlyBurn:37.5,runwayDays:4}));
 assert.match(view,/Daily burn\s+\$1\.25/);
 assert.match(view,/Weekly projection\s+\$8\.75/);
 assert.match(view,/Known balance\s+\$5\.00/);
});


test('mixed-provider runway is explicitly partial',()=>{
 const view=text(browser.renderBurnCard({providers:[{provider:'balance-only',lastBalance:5,dailyBurn:null},{provider:'burn-only',lastBalance:null,dailyBurn:1.25}],totalDailyBurn:1.25,totalBalance:5,weeklyBurn:8.75,monthlyBurn:37.5,runwayDays:4}));
 assert.match(view,/Partial runway\s+4 days/);
 assert.match(view,/known balance \/ measured burn; partial estimate/);
});

test('provider card excludes nonfinite or nonnumeric balances',()=>{
 const nodes={}; browser.document={getElementById:id=>nodes[id]||(nodes[id]={})};
 const burn={ok:true,providers:[{provider:'bad-string',lastBalance:'12'},{provider:'bad-infinite',lastBalance:Infinity}],totalBalance:0,totalDailyBurn:0};
 browser.render({ok:true,providers:[]},burn);
 assert.ok(!nodes.dashboardGrid.innerHTML.includes('Provider Balances'));
 burn.providers.push({provider:'valid-zero',lastBalance:0,dailyBurn:null});
 browser.render({ok:true,providers:[]},burn);
 assert.ok(nodes.dashboardGrid.innerHTML.includes('Provider Balances'));
 assert.ok(!nodes.dashboardGrid.innerHTML.includes('Bad-string'));
 assert.ok(!nodes.dashboardGrid.innerHTML.includes('Bad-infinite'));
});
