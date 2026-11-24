"""Synthetic rehearsal. Called only by the runner that owns a disposable lb_test container."""
import csv
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import socket
import urllib.request
from migration.core import CLASSES, POLICIES, approve, canonical, file_hash, legacy_archive, make_plan, normalize, review_csv, write
from migration.test_migration import bundle


def main():
    binary, work = sys.argv[1], Path(sys.argv[2])
    container = os.environ['LB_MIGRATION_CONTAINER']
    if not container.startswith('lb-migration-test-') or os.environ.get('APP_ENV') != 'local':
        raise SystemExit('Use scripts/test-migration.sh')
    started = time.monotonic()
    def command(*args, good=True):
        r = subprocess.run([binary, *map(str, args)], capture_output=True)
        if (r.returncode == 0) != good:
            raise AssertionError('Unexpected CLI result: ' + r.stderr.decode())
    def sql(statement):
        return subprocess.check_output(['docker','exec',container,'psql','-At','-U','postgres','-d','lb_test','-c',statement]).decode().strip()
    def snapshot(name):
        path = work / (name + '.json'); command('catalog-snapshot', path)
        return json.loads(path.read_text())
    def plan_and_approve(catalog, target, label):
        directory = work / label
        plan = make_plan(catalog,target,'reconcile')
        assert not plan['conflicts'], plan['conflicts']
        for name,value in [('catalog.json',catalog),('plan.json',plan),('policies.json',{**{k:True for k in POLICIES},'target_settings_hash':target.get('settings_hash',''),'retained_decisions':{r['kind']+':'+r['key']:'keep' for r in plan['retained']}})]: write(directory/name,value)
        review_csv(directory/'review.csv',catalog)
        with (directory/'review.csv').open() as f: rows=list(csv.DictReader(f));fields=list(rows[0])
        for row in rows:
            for k in fields:
                if k=='approved' or k.endswith('_verified'): row[k]='yes'
        with (directory/'review.csv').open('w') as f:
            w=csv.DictWriter(f,fields);w.writeheader();w.writerows(rows)
        approval=approve(directory/'plan.json',directory/'catalog.json',directory/'review.csv',directory/'policies.json','Synthetic fixture owner')
        write(directory/'approval.json',approval)
        return directory,plan
    b=bundle()
    b['products'][0]['description']='<p>Fixture &amp; safe photo <img alt="Cookware" src="https://res.cloudinary.com/fixture/image/upload/test.png"></p>'
    b['orders']=[{'id':70,'status':'processing','total':'1250.50','currency':'BDT','customer_id':4,'date_created_gmt':'2020-01-01T00:00:00','billing':{'phone':'01710000000'}},{'id':71,'status':'completed','total':'1000.00','currency':'BDT','customer_id':4,'date_created_gmt':'2020-01-02T00:00:00'}]
    b['customers']=[{'id':4,'email':'fixture@example.invalid','billing':{'phone':'01710000000'}}]
    source=work/'source';source.mkdir(mode=0o700)
    m=b['manifest'];m.update(started_at='2026-11-18T00:00:00Z',finished_at='2026-11-18T00:01:00Z',files={})
    for key in CLASSES:
        p=source/f'{key}.jsonl';p.write_bytes(b''.join(canonical(r)+b'\n' for r in b[key]));p.chmod(0o600)
        m['files'][key]={'file':p.name,'count':len(b[key]),'sha256':file_hash(p)}
    write(source/'manifest.json',m)
    empty=snapshot('empty-target')
    catalog=normalize(b)
    prepared=work/'cli-prepared'
    cli=subprocess.run([sys.executable,'scripts/import_wp.py','prepare',str(source),'--target',str(work/'empty-target.json'),'--policy','reconcile','--output',str(prepared)],capture_output=True,check=True)
    assert json.loads(cli.stdout)['changes']==len(catalog['records'])
    assert json.loads((prepared/'catalog.json').read_text())==catalog
    subprocess.run([sys.executable,'scripts/images_to_cloudinary.py','plan','--catalog',str(prepared/'catalog.json'),'--manifest',str(work/'asset-manifest.json')],capture_output=True,check=True)
    folder,plan=plan_and_approve(catalog,empty,'initial')
    command('catalog-apply',folder/'plan.json',folder/'approval.json')
    command('catalog-apply',folder/'plan.json',folder/'approval.json')
    after=snapshot('after-initial')
    assert not make_plan(catalog,after,'reconcile')['records'], 'Import rerun should have zero changes'
    # These are the exact in-memory endpoints consumed by the static build, not database reads per visitor.
    with socket.socket() as listener:
        listener.bind(('127.0.0.1',0));api_port=listener.getsockname()[1]
    environment={**os.environ,'DEV':'1','APP_ENV':'local','PORT':str(api_port),'ADMIN_TOKEN':'local-admin-token-for-this-computer-only'}
    with (work/'api.log').open('wb') as log:
        process=subprocess.Popen([binary],env=environment,stdout=log,stderr=log)
        try:
            ready=False
            for attempt in range(100):
                try:
                    with urllib.request.urlopen(f'http://127.0.0.1:{api_port}/api/ready',timeout=1) as response: ready=response.status==200
                    if ready: break
                except OSError: time.sleep(.05)
            assert ready,'API did not become ready'
            with urllib.request.urlopen(f'http://127.0.0.1:{api_port}/api/catalog') as response: build_catalog=json.load(response)
            with urllib.request.urlopen(f'http://127.0.0.1:{api_port}/api/stock') as response: availability=json.load(response)
            assert next(p for p in build_catalog if p['id']==10)['price']==1250
            assert availability['products']['10']==[1250,1500,3]
        finally:
            process.terminate()
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired: process.kill();process.wait()
    archive=legacy_archive(b,work/'legacy.sqlite')
    assert archive['outstanding_orders']==1 and archive['totals_by_currency']=={'BDT':'2250.50'}
    assert sql('SELECT count(*) FROM orders')=='0', 'Historical archive must not become live orders'
    backup=work/'restore-point.dump'
    with backup.open('wb') as f: subprocess.run(['docker','exec',container,'pg_dump','-Fc','-U','postgres','-d','lb_test'],stdout=f,check=True)
    backup.chmod(0o600)
    b['products'][0].update(stock_quantity=5,price='1300')
    changed=normalize(b)
    delta,delta_plan=plan_and_approve(changed,after,'delta')
    assert len(delta_plan['records'])==1
    sql('UPDATE products SET stock=stock-1 WHERE id=10')
    command('catalog-apply',delta/'plan.json',delta/'approval.json',good=False)
    assert sql('SELECT stock FROM products WHERE id=10')=='2'
    fresh=snapshot('after-admin-change')
    reviewed,_=plan_and_approve(changed,fresh,'reviewed-delta')
    command('catalog-apply',reviewed/'plan.json',reviewed/'approval.json')
    assert sql('SELECT stock||\',\'||price FROM products WHERE id=10')=='5,1300'
    b['orders'][0]['status']='completed'
    assert legacy_archive(b,work/'legacy.sqlite')['outstanding_orders']==0
    assert sql('SELECT stock FROM products WHERE id=10')=='5', 'Historical status changes must not alter new inventory'
    restore_started=time.monotonic()
    with backup.open('rb') as f: subprocess.run(['docker','exec','-i',container,'pg_restore','--clean','--if-exists','--no-owner','-U','postgres','-d','lb_test'],stdin=f,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,check=True)
    assert sql('SELECT stock||\',\'||price FROM products WHERE id=10')=='3,1250'
    restore_seconds=round(time.monotonic()-restore_started,3)
    sql('DELETE FROM products WHERE id=10')
    removed=snapshot('after-delete')
    assert make_plan(catalog,removed,'reconcile')['conflicts']
    command('catalog-apply',reviewed/'plan.json',reviewed/'approval.json',good=False)
    sql("INSERT INTO orders(number,name,phone,address,area,payment,subtotal,shipping,total) VALUES('FIXTURE','Fixture','01710000000','Fixture address','local','cod',0,0,0)")
    command('catalog-apply',folder/'plan.json',folder/'approval.json',good=False)
    sql('DELETE FROM orders')
    command('catalog-apply',folder/'plan.json',folder/'approval.json',good=False)
    report={'fixture_only':True,'products':len(b['products']),'archived_orders':2,'initial_outstanding_orders':1,'legacy_total_BDT':'2250.50','rerun_changes':0,'build_input_snapshot_verified':True,'stale_plan_rejected':True,'safe_delta_verified':True,'deleted_product_resurrection_refused':True,'post_order_migration_permanently_closed':True,'restore_seconds':restore_seconds,'elapsed_seconds':round(time.monotonic()-started,3)}
    write(work/'rehearsal-report.json',report)
    print(json.dumps(report))

if __name__=='__main__':main()
