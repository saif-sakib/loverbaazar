import copy
import csv
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from migration.core import CLASSES, Invalid, POLICIES, approve, archive_note, canonical, digest, editorial_audit, file_hash, legacy_archive, load_bundle, lookup, make_plan, normalize, private, review_csv, slug, write
from migration import assets


def bundle():
    return {'manifest': {'version': 1, 'origin': 'https://shop.example', 'currency': 'BDT'}, **{k: [] for k in CLASSES},
            'pages': [{'id': i + 50, 'slug': slug, 'status':'publish', 'title':{'raw':'Fixture ' + slug}, 'content':{'raw':'<p>Synthetic policy fixture for testing only.</p>'}} for i,slug in enumerate(['about-us','how-to-buy','terms-conditions','privacy-policy'])],
            'categories': [{'id': 1, 'slug': 'kitchen', 'name': 'Kitchen', 'parent': 0}],
            'products': [{'id': 10, 'slug': '%E0%A6%B9%E0%A6%BE%E0%A6%81%E0%A6%A1%E0%A6%BC%E0%A6%BF', 'name': 'হাঁড়ি', 'sku': 'MODEL-A', 'type': 'simple', 'status': 'publish', 'price': '1250.00', 'regular_price': '1500', 'manage_stock': True, 'stock_quantity': 3, 'stock_status': 'instock', 'backorders': 'no', 'categories': [{'id': 1}], 'images': [{'src': 'https://shop.example/wp-content/uploads/cooker.png'}]}]}


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
    def tearDown(self):
        self.temp.cleanup()
    def test_export_integrity_and_explicit_zero_coverage(self):
        b = bundle(); m = b['manifest']
        m.update(started_at='2026-11-18T00:00:00Z', finished_at='2026-11-18T00:01:00Z', files={})
        for key in CLASSES:
            path = self.root / f'{key}.jsonl'; path.write_bytes(b''.join(canonical(r) + b'\n' for r in b[key]))
            m['files'][key] = {'file': path.name, 'count': len(b[key]), 'sha256': file_hash(path)}
        write(self.root / 'manifest.json', m)
        self.assertEqual(len(load_bundle(self.root)['products']), 1)
        (self.root / 'products.jsonl').write_text('{}\n')
        with self.assertRaises(Invalid): load_bundle(self.root)
        m['files'].pop('orders'); write(self.root / 'manifest.json', m)
        with self.assertRaises(Invalid): load_bundle(self.root)
    def test_currency_precision_and_unknown_stock_never_invent_units(self):
        for change, issue in [({'price': '1250.5'}, 'whole-taka'), ({'manage_stock': False}, 'stock'), ({'stock_quantity': None}, 'stock'), ({'backorders': 'yes'}, 'stock'), ({'sold_individually': True}, 'sold-individually'), ({'type': 'variable'}, 'options'), ({'stock_quantity': -1}, 'stock')]:
            b = bundle(); b['products'][0].update(change); c = normalize(b)
            self.assertFalse(c['review'][0]['active'])
            self.assertIn(issue, c['review'][0]['issues'])
        disabled = bundle(); disabled['manifest']['stock_management_enabled'] = False
        self.assertFalse(normalize(disabled)['review'][0]['active'])
        self.assertTrue(normalize(disabled, {'10':{'manage_stock':True,'stock_quantity':3}})['review'][0]['active'])
        b = bundle(); b['products'][0]['prices'] = {'currency_code': 'BDT', 'currency_minor_unit': 0, 'price': '1250', 'regular_price': '1500'}
        self.assertEqual(normalize(b)['review'][0]['price'], 1250)
        b['products'][0]['prices'].update(currency_minor_unit=2, price='125000', regular_price='150000')
        self.assertEqual(normalize(b)['review'][0]['price'], 1250)
        b['products'][0]['prices']['currency_code'] = 'USD'
        self.assertFalse(normalize(b)['review'][0]['active'])
    def test_duplicates_encoded_slugs_and_category_cycles(self):
        c = normalize(bundle()); self.assertEqual(next(r for r in c['records'] if r['kind']=='product')['value']['slug'], 'হাঁড়ি')
        with self.assertRaises(Invalid): slug('%252f')
        with self.assertRaises(Invalid): normalize(bundle(), {'10':{'id':11}})
        b = bundle(); b['products'].append(copy.deepcopy(b['products'][0]))
        with self.assertRaises(Invalid): normalize(b)
        b = bundle(); b['categories'][0]['parent'] = 1
        with self.assertRaises(Invalid): normalize(b)
        b = bundle(); other = copy.deepcopy(b['products'][0]); other.update(id=11, slug='another'); b['products'].append(other)
        with self.assertRaises(Invalid): normalize(b)
    def test_more_than_three_pages_no_fixed_count(self):
        b = bundle(); p = b['products'][0]
        b['products'] = [{**p, 'id': i + 1, 'slug': f'product-{i}', 'sku': f'SKU-{i}'} for i in range(431)]
        self.assertEqual(len(normalize(b)['review']), 431)
    def test_plan_requires_explicit_updates_and_preserves_deletions(self):
        c = normalize(bundle()); row = next(r for r in c['records'] if r['kind'] == 'product')
        target = {'records': [{**row, 'value': {**row['value'], 'stock': 9}, 'hash': 'baseline'}], 'imported': []}
        self.assertEqual(len(make_plan(c, target)['conflicts']), 1)
        plan = make_plan(c, target, 'reconcile')
        self.assertEqual(next(r for r in plan['records'] if r['kind'] == 'product')['expected'], 'baseline')
        target = {'records': [], 'imported': ['product:10']}
        self.assertEqual(make_plan(c, target)['conflicts'][0]['reason'].split(';')[0], 'previously-imported-record-was-deleted')
    def test_archive_is_idempotent_private_and_keeps_exact_legacy_totals(self):
        b = bundle(); b['orders'] = [{'id': 7, 'status': 'processing', 'total': '1250.50', 'currency': 'BDT', 'customer_id': 4, 'date_created_gmt': '2020-01-01T00:00:00', 'billing': {'phone': '01710000000'}, 'order_key': 'private-key', 'payment_url':'https://shop.example/order-pay/?key=wc_order_fixture', 'password': 'never-import', 'legacy_stock_reduced':True, 'line_items':[{'product_id':10,'variation_id':0,'quantity':1}]}]
        b['customers'] = [{'id': 4, 'email': 'fixture@example.invalid', 'password_hash': 'never-import'}]
        db = self.root / 'archive.sqlite'
        first = legacy_archive(b, db); second = legacy_archive(b, db)
        self.assertEqual(first, second); self.assertEqual(first['totals_by_currency'], {'BDT': '1250.50'})
        self.assertEqual(first['outstanding_orders'], 1)
        self.assertEqual(first['outstanding_gross_units_by_product_variation']['10:0']['already_reduced'],1)
        record = lookup(db, 7)[0]
        self.assertNotIn('password', record)
        self.assertNotIn('order_key', record)
        self.assertNotIn('payment_url', record)
        self.assertEqual(record['customer_id'], 4)
        self.assertEqual(record['archive_created_dhaka'], '2020-01-01T06:00:00+06:00')
        self.assertTrue(record['archive_only'])
        archive_note(db,7,'fixture-shipping','shipped','Fixture tracking 123','Fixture operator')
        archive_note(db,7,'fixture-shipping','shipped','Fixture tracking 123','Fixture operator')
        legacy_archive(b,db)
        self.assertEqual(len(lookup(db,7)[0]['archive_actions']),1)
        with self.assertRaises(Invalid): archive_note(db,7,'fixture-shipping','shipped','Changed action','Fixture operator')
        self.assertEqual(db.stat().st_mode & 0o777, 0o600)
    def test_review_binds_exact_plan_and_does_not_silently_apply_csv_edits(self):
        c = normalize(bundle()); p = make_plan(c, {'records': [], 'imported': []})
        cat, plan, review, policies = [self.root / n for n in ['catalog.json', 'plan.json', 'review.csv', 'policies.json']]
        write(cat, c); write(plan, p); review_csv(review, c); write(policies, {k: True for k in POLICIES})
        with self.assertRaises(Invalid): approve(plan, cat, review, policies, 'Fixture owner')
        with review.open() as f: rows = list(csv.DictReader(f)); fields = list(rows[0])
        for row in rows:
            for k in fields:
                if k.endswith('_verified') or k == 'approved': row[k] = 'yes'
        with review.open('w') as f:
            w = csv.DictWriter(f, fields); w.writeheader(); w.writerows(rows)
        self.assertEqual(approve(plan, cat, review, policies, 'Fixture owner')['plan_sha256'], file_hash(plan))
        rows[0]['stock'] = '900'
        with review.open('w') as f:
            w = csv.DictWriter(f, fields); w.writeheader(); w.writerows(rows)
        with self.assertRaises(Invalid): approve(plan, cat, review, policies, 'Fixture owner')
    def test_sanitization_editorial_audit_and_private_output(self):
        b = bundle(); b['products'][0].update(description='<p onclick="bad()">Warranty <img src="javascript:bad"><script>bad()</script></p> [old_shortcode]')
        c = normalize(b)
        body = next(r for r in c['records'] if r['kind'] == 'product')['value']['desc']
        self.assertNotIn('onclick', body); self.assertNotIn('<script', body); self.assertNotIn('javascript:', body)
        self.assertTrue(editorial_audit(c))
        with self.assertRaises(Invalid): private(Path(__file__).resolve().parents[2] / 'public' / 'private.json')
    def test_all_public_asset_classes_deterministic_resumable_and_bounded(self):
        c = normalize(bundle())
        c['records'] += [{'kind': 'page', 'key': 'about', 'value': {'slug': 'about', 'html': '<img src="/wp-content/uploads/about.png">'}}, {'kind': 'post', 'key': 'guide', 'value': {'slug': 'guide', 'html': '<a href="/wp-content/uploads/guide.pdf">Download</a>'}}]
        c['site'] = {'logo': 'https://shop.example/wp-content/uploads/logo.png'}
        m = assets.inventory(c)
        self.assertEqual(len(m['assets']), 4)
        self.assertEqual(assets.inventory(c, copy.deepcopy(m)), m)
        self.assertTrue(any(a['public_id'].startswith('loverbaazar/site/') for a in m['assets'].values()))
        data = b'\x89PNG\r\n\x1a\n' + b'\0' * 8 + (1).to_bytes(4, 'big') * 2
        class Response(io.BytesIO): headers = {}
        calls = []
        def opener(req, timeout): calls.append(req.full_url); return Response(data)
        assets.download(m, self.root / 'files', 1000, opener)
        self.assertEqual(len(calls), 4)
        assets.download(m, self.root / 'files', 1000, opener)
        self.assertEqual(len(calls), 4)
        with self.assertRaises(Invalid): assets.rewrite(c, m)
        for a in m['assets'].values(): a.update(status='verified', destination='https://res.cloudinary.com/fixture/image/upload/' + a['public_id'])
        self.assertNotIn('/wp-content/', json.dumps(assets.rewrite(c, m)['records']))
        self.assertEqual(len(assets.redirects(m)), 4)
        small = assets.inventory(c); assets.download(small, self.root / 'small', 1, opener)
        self.assertTrue(all(a['status'] == 'failed' for a in small['assets'].values()))
    def test_cloud_quota_and_redirects_fail_closed(self):
        for usage in [{}, {'plan': 'Paid'}, {'plan': 'Free', 'credits': {'limit': 25, 'usage': 24}}]:
            with self.assertRaises(Invalid): assets.check_quota(usage, 1024)
        assets.check_quota({'plan': 'Free', 'credits': {'limit': 25, 'usage': 1}}, 1024)
        with self.assertRaises(Invalid): assets.validate_source('https://other.invalid/file', {'shop.example'})
        with self.assertRaises(Invalid): assets.validate_source('https://shop.example@evil.invalid/file', {'shop.example'})


class AdditionalMigrationTests(unittest.TestCase):
    def test_backup_inspection_and_unsafe_archives(self):
        import gzip,zipfile
        from migration.evidence import inspect_evidence
        with tempfile.TemporaryDirectory() as d:
            folder=Path(d)
            sql=folder/'backup.sql.gz'
            with gzip.open(sql,'wb') as f:f.write(b'-- Synthetic SQL backup\nCREATE TABLE fixture(id int);')
            archive=folder/'uploads.zip'
            with zipfile.ZipFile(archive,'w') as z:z.writestr('uploads/fixture.txt','Synthetic attachment')
            dns,hosting=folder/'dns.txt',folder/'hosting.txt';dns.write_text('Fixture DNS');hosting.write_text('Fixture hosting inventory')
            evidence={'sql_backup':sql,'uploads_backup':archive,'dns_zone':dns,'hosting_inventory':hosting}
            report=inspect_evidence(evidence)
            self.assertFalse(report['restore_verified']);self.assertEqual(report['evidence']['sql_backup']['sha256'],file_hash(sql))
            with zipfile.ZipFile(archive,'w') as z:z.writestr('../unsafe.txt','no')
            with self.assertRaises(Invalid):inspect_evidence(evidence)
    def test_asset_replacement_retains_rollback_versions(self):
        m=assets.inventory(normalize(bundle()));source=next(iter(m['assets']));old=m['assets'][source]
        old.update(sha256='old-checksum',bytes=100,status='verified',destination='https://res.cloudinary.com/fixture/old.png')
        pid=old['public_id'];assets.renew(m,source)
        new=m['assets'][source]
        self.assertNotEqual(new['public_id'],pid)
        self.assertEqual(new['history'][0]['destination'],'https://res.cloudinary.com/fixture/old.png')
        self.assertNotIn('sha256',new)
        with self.assertRaises(Invalid):assets.rewrite(normalize(bundle()),m)
    def test_upload_resume_verifies_destination_identity_and_never_overwrites(self):
        import urllib.error
        import os
        with tempfile.TemporaryDirectory() as d:
            folder=Path(d);data=b'\x89PNG\r\n\x1a\n'+b'\0'*8+(1).to_bytes(4,'big')*2
            class Response(io.BytesIO):headers={}
            m=assets.inventory(normalize(bundle()));assets.download(m,folder,1000,lambda *a,**k:Response(data))
            a=next(iter(m['assets'].values()));uploads=[];saved=[]
            remote={'public_id':a['public_id'],'asset_id':'fixture-asset','bytes':len(data),'secure_url':'https://res.cloudinary.com/fixture/image/upload/file.png','context':{'custom':{'source_sha256':a['sha256']}}}
            exists=False
            def cloud(path,body=None):
                nonlocal exists
                if path=='usage':return {'plan':'Free','credits':{'limit':25,'usage':1}}
                if path.startswith('resources/'):
                    if not exists:raise urllib.error.HTTPError('fixture',404,'Missing',{},None)
                    return remote
                uploads.append(body);exists=True;return remote
            with patch.dict(os.environ,{'CLOUDINARY_CLOUD':'fixture'}),patch.object(assets,'cloud_request',side_effect=cloud),patch.object(assets.urllib.request,'urlopen',side_effect=lambda *a,**k:Response(data)):
                assets.upload(m,folder,1000,lambda value:saved.append(copy.deepcopy(value)))
                assets.upload(m,folder,1000,lambda value:saved.append(copy.deepcopy(value)))
                self.assertEqual(len(uploads),1);self.assertEqual(uploads[0]['overwrite'],'false')
                self.assertEqual(a['status'],'verified')
                remote['context']['custom']['source_sha256']='collision'
                with self.assertRaises(Invalid):assets.upload(m,folder,1000,lambda value:None)

    def test_protected_and_private_source_content_never_becomes_public_assets(self):
        b=bundle();b['products'][0]['protected_content']=True
        b['pages']=[{'id':8,'slug':'private-page','status':'private','title':{'raw':'Private'},'content':{'raw':'<img src="/wp-content/uploads/private.png">'}}, {'id':9,'slug':'protected-page','status':'publish','protected_content':True,'title':{'raw':'Protected'},'content':{'raw':'Private body'}},{'id':11,'slug':'','status':'auto-draft','title':{'raw':''},'content':{'raw':''}}]
        c=normalize(b)
        self.assertFalse(c['review'][0]['active'])
        self.assertTrue(all(r['value']['draft'] for r in c['records'] if r['kind']=='page'))
        self.assertEqual(assets.inventory(c)['assets'],{})
        self.assertTrue(c['excluded'])

    def test_final_source_revalidation_refuses_changed_bytes_without_losing_rollback(self):
        with tempfile.TemporaryDirectory() as d:
            folder=Path(d);data=b'\x89PNG\r\n\x1a\n'+b'\0'*8+(1).to_bytes(4,'big')*2
            class Response(io.BytesIO):headers={}
            m=assets.inventory(normalize(bundle()))
            assets.download(m,folder,len(data),lambda *a,**k:Response(data))
            a=next(iter(m['assets'].values()));a.update(status='verified',destination='https://res.cloudinary.com/fixture/image/upload/old.png')
            assets.download(m,folder,len(data),lambda *a,**k:Response(data),revalidate=True)
            self.assertEqual(a['status'],'verified')
            assets.download(m,folder,1000,lambda *a,**k:Response(data+b'changed'),revalidate=True)
            self.assertEqual(a['status'],'failed');self.assertIn('Source changed',a['failure_reason'])
            self.assertEqual((folder/a['local_file']).read_bytes(),data)
            self.assertEqual(a['destination'],'https://res.cloudinary.com/fixture/image/upload/old.png')

    def test_cloudinary_signature_excludes_file_and_authentication_fields(self):
        import os,urllib.parse,hashlib
        seen=[]
        class Response(io.BytesIO):pass
        def send(req,timeout):seen.append(req);return Response(b'{}')
        with patch.dict(os.environ,{'CLOUDINARY_CLOUD':'fixture','CLOUDINARY_KEY':'fixture-key','CLOUDINARY_SECRET':'fixture-signing-value'}),patch.object(assets.time,'time',return_value=123),patch.object(assets.urllib.request,'urlopen',side_effect=send):
            assets.cloud_request('image/upload',{'public_id':'loverbaazar/products/fixture/item-1','overwrite':'false','file':'data:image/png;base64,fixture'})
        body=urllib.parse.parse_qs(seen[0].data.decode())
        expected=hashlib.sha1(b'overwrite=false&public_id=loverbaazar/products/fixture/item-1&timestamp=123fixture-signing-value').hexdigest()
        self.assertEqual(body['signature'],[expected])
        self.assertEqual(body['api_key'],['fixture-key'])

if __name__ == '__main__': unittest.main()
