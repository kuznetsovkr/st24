import copy
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

if sys.platform == 'linux':
    import retention as r


NOW = datetime(2026, 10, 20, 3, tzinfo=timezone.utc)
NAMES = ['2026-10-09_01-00-00_UTC', '2026-10-09_02-00-00_UTC',
         '2026-10-18_04-00-00_UTC', '2026-10-19_04-00-00_UTC', '2026-10-20_00-30-01_UTC']


@unittest.skipUnless(sys.platform == 'linux', 'Linux-only backup retention')
class RetentionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='karcher-retention-test-')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.plain = self.base/'plain';self.enc = self.base/'encrypted';self.remote = self.base/'cloud'
        self.state = self.base/'state';self.trash=self.base/'trash'
        for p in [self.plain,self.enc,self.remote,self.state,self.trash]:p.mkdir(mode=0o700)
        self.recipient = self.base/'recipients.txt'
        self.recipient.write_text('age1synthetictestpublickey\n');self.recipient.chmod(0o600)
        self.settings = {**r.DEFAULT,'enabled':True,'pinned':[NAMES[1],NAMES[3]]}
        for name in NAMES:self.make_set(name)
        self.stamp = {'backupSet':NAMES[-1],'checkedAt':'2026-10-20T00:30:13Z',
                      'status':'verified','stage':'complete','encryption':'age-x25519-v1'}
        for name in ['.last-run.json','.last-success.json']:self.write(self.plain/name,json.dumps(self.stamp).encode())
        for key,value in [('PLAIN',self.plain),('ENCRYPTED',self.enc),('RECIPIENTS',self.recipient)]:
            patcher=patch.object(r,key,value);patcher.start();self.addCleanup(patcher.stop)
        self.calls=[]
        owner=self
        class FakeCloud(r.Cloud):
            def call(self,args):
                owner.calls.append(args)
                command,target=args[:2]
                if command=='lsjson':
                    directory=owner.remote if target==r.REMOTE else owner.remote/target.removeprefix(r.REMOTE+'/')
                    rows=[]
                    for path in sorted(directory.iterdir()):
                        rows.append({'Name':path.name,'Path':path.name,'IsDir':path.is_dir(),
                                     'Size':path.stat().st_size,'ModTime':str(path.stat().st_mtime_ns),
                                     'Hashes':{} if path.is_dir() else {'MD5':hashlib.md5(path.read_bytes()).hexdigest()}})
                    return json.dumps(rows).encode()
                if command=='copy':
                    source=owner.remote/target.removeprefix(r.REMOTE+'/')
                    for path in source.iterdir():shutil.copy2(path,Path(args[2])/path.name)
                    return b''
                if command=='purge':
                    owner.assertEqual(args[-1],'--yandex-hard-delete=false')
                    name=target.removeprefix(r.REMOTE+'/');r.moment(name)
                    (owner.remote/name).rename(owner.trash/name)
                    return b''
                raise AssertionError('Unexpected command')
        self.cloud=FakeCloud(self.state/'rclone.log')

    def write(self,path,data):
        path.write_bytes(data);path.chmod(0o600)

    def checksums(self,path,names):
        self.write(path/'SHA256SUMS.txt',''.join(hashlib.sha256((path/n).read_bytes()).hexdigest()+'  '+n+'\n' for n in sorted(names)).encode())

    def make_set(self,name):
        p=self.plain/name;e=self.enc/name;c=self.remote/name
        p.mkdir(mode=0o700);e.mkdir(mode=0o700);c.mkdir(mode=0o700)
        for file in r.COMPONENTS:self.write(p/file,(file+name).encode())
        self.checksums(p,r.COMPONENTS)
        self.write(e/'backup.tar.age',b'synthetic-ciphertext-not-real-encryption:'+name.encode())
        manifest={'format':r.FORMAT,'contents':sorted(r.CONTENTS),'recipientSha256':r.recipient_id(self.recipient),
                  'createdAt':(r.moment(name)+timedelta(seconds=5)).isoformat()}
        self.write(e/'MANIFEST.json',json.dumps(manifest).encode());self.checksums(e,r.ENCRYPTED_FILES)
        for file in r.EXPORT_FILES:shutil.copy2(e/file,c/file)

    def plan(self):return r.plan(self.settings,NOW,self.cloud,self.state)

    def apply(self,plan):return r.apply(plan,self.cloud,lambda:r.fresh_checkpoint(NOW),lambda e:r.atomic_json(self.state/'action.json',e))

    def test_plan_is_read_only_and_preserves_pins_latest_three_daily_and_legacy(self):
        legacy=self.plain/'2020-01-01_03-30-01';legacy.mkdir(mode=0o700);self.write(legacy/'valuable',b'keep')
        partial=self.plain/'.2026-10-19_01-01-01_UTC.partial.123';partial.mkdir(mode=0o700)
        self.write(partial/'unfinished',b'keep partial')
        plan=self.plan()
        self.assertEqual(plan['cloudDelete'],[NAMES[0]])
        self.assertEqual(plan['localDelete'],[NAMES[0]])
        self.assertFalse(any(call[0]=='purge' for call in self.calls))
        self.assertEqual((legacy/'valuable').read_bytes(),b'keep')
        self.assertTrue((partial/'unfinished').exists())
        self.assertEqual(len(plan['cloud']),5)

    def test_apply_removes_only_the_selected_pair_and_moves_cloud_to_trash(self):
        result=self.apply(self.plan())
        self.assertEqual(result,{'cloud':[NAMES[0]],'local':[NAMES[0]]})
        self.assertTrue((self.trash/NAMES[0]/'backup.tar.age').exists())
        self.assertFalse((self.plain/NAMES[0]).exists())
        self.assertFalse((self.enc/NAMES[0]).exists())
        for name in NAMES[1:]:self.assertTrue((self.plain/name).exists());self.assertTrue((self.remote/name).exists())
        self.assertEqual(r.json_file(self.plain/'.last-success.json'),self.stamp)

    def test_disabled_policy_never_applies(self):
        plan=self.plan();plan['settings']={**plan['settings'],'enabled':False}
        with self.assertRaisesRegex(r.RetentionError,'POLICY_NOT_ENABLED'):self.apply(plan)
        self.assertFalse(any(call[0]=='purge' for call in self.calls))

    def test_invalid_policy_traversal_dates_duplicates_and_booleans_are_rejected(self):
        for change in [{'enabled':1},{'localDays':False},{'dailyDays':0},{'pinned':['../../elsewhere']},
                       {'pinned':['2026-99-01_00-00-00_UTC']},{'pinned':[NAMES[0],NAMES[0]]},{'unknown':'x'}]:
            with self.subTest(change=change),self.assertRaises(r.RetentionError):r.policy({**self.settings,**change})
        for name in ['../outside','',r.REMOTE,'2026-10-20_00-00-00_UTC/../elsewhere']:
            with self.subTest(name=name),self.assertRaises(r.RetentionError):self.cloud.remove(name,[])

    def test_corrupt_or_unexpected_cloud_content_blocks_all_deletion(self):
        self.write(self.remote/NAMES[0]/'backup.tar.age',b'corrupted')
        with self.assertRaises(r.CryptoError):self.plan()
        self.assertFalse(any(call[0]=='purge' for call in self.calls))

    def test_unexpected_local_files_or_symlinks_block_deletion(self):
        directory=self.enc/NAMES[0]
        self.write(directory/'unexpected',b'not a backup component')
        with self.assertRaises(r.RetentionError):self.plan()
        (directory/'unexpected').unlink()
        (directory/'backup.tar.age').unlink();(directory/'backup.tar.age').symlink_to('/not-followed')
        with self.assertRaises(r.RetentionError):self.plan()

    def test_missing_pin_cloud_survivor_and_local_pair_fail_closed(self):
        self.settings['pinned']=['2026-01-01_00-00-00_UTC']
        with self.assertRaises(r.RetentionError):self.plan()
        self.settings['pinned']=[NAMES[1],NAMES[3]]
        (self.remote/NAMES[1]).rename(self.trash/NAMES[1])
        with self.assertRaisesRegex(r.RetentionError,'UNMIRRORED'):self.plan()

    def test_failed_stale_or_future_latest_backup_blocks_cleanup(self):
        for change in [{'status':'failed'},{'checkedAt':'2026-10-17T00:00:00Z'},
                       {'checkedAt':'2026-10-21T00:00:00Z'}]:
            value={**self.stamp,**change}
            for file in ['.last-run.json','.last-success.json']:self.write(self.plain/file,json.dumps(value).encode())
            with self.subTest(change=change),self.assertRaises(r.RetentionError):self.plan()

    def test_changed_survivor_or_checkpoint_aborts_before_any_delete(self):
        plan=self.plan()
        self.write(self.remote/NAMES[-1]/'backup.tar.age',b'changed after plan')
        with self.assertRaisesRegex(r.RetentionError,'SURVIVOR_CHANGED'):self.apply(plan)
        self.assertFalse(any(call[0]=='purge' for call in self.calls))
        with self.assertRaisesRegex(r.RetentionError,'CHECKPOINT_CHANGED'):
            r.apply(plan,self.cloud,lambda:{'different':'checkpoint'},lambda e:None)

    def test_tampered_plan_cannot_target_pins_latest_or_last_three(self):
        for name in [NAMES[1],NAMES[2],NAMES[-1]]:
            plan=self.plan();plan['cloudDelete']=[name];plan['cloudKeep'].remove(name)
            with self.subTest(name=name),self.assertRaisesRegex(r.RetentionError,'PROTECTED_DELETE'):self.apply(plan)

    def test_local_change_after_plan_is_not_unlinked(self):
        plan=self.plan();path=self.plain/NAMES[0]/'st24_db.dump';self.write(path,b'changed')
        with self.assertRaisesRegex(r.RetentionError,'LOCAL_CHANGED_BEFORE_DELETE'):self.apply(plan)
        self.assertEqual(path.read_bytes(),b'changed')
        self.assertTrue((self.enc/NAMES[0]).exists())

    def test_cloud_failure_stops_without_deleting_local_data(self):
        plan=self.plan()
        with patch.object(self.cloud,'remove',side_effect=r.RetentionError('CLOUD_OPERATION_FAILED')):
            with self.assertRaises(r.RetentionError):self.apply(plan)
        for name in NAMES:self.assertTrue((self.plain/name).exists())

    def test_transient_cloud_reads_require_complete_success_and_persistent_errors_stop(self):
        original=self.cloud.call
        attempts=[0]
        def call(args):
            if args[0]=='copy':
                attempts[0]+=1
                if attempts[0]<3:raise r.RetentionError('CLOUD_OPERATION_FAILED')
            return original(args)
        with tempfile.TemporaryDirectory(dir=self.state) as output, \
                patch.object(self.cloud,'call',side_effect=call),patch.object(r.time,'sleep'):
            verified=self.cloud.verify(NAMES[0],Path(output),r.recipient_id(self.recipient))
            self.assertEqual(verified['digests'],r.local_set(self.enc,NAMES[0],True)['digests'])
        self.assertEqual(attempts[0],3)
        def persistent(args):
            if args[0]=='copy':raise r.RetentionError('CLOUD_OPERATION_FAILED')
            return original(args)
        with tempfile.TemporaryDirectory(dir=self.state) as output, \
                patch.object(self.cloud,'call',side_effect=persistent),patch.object(r.time,'sleep'):
            with self.assertRaises(r.RetentionError):self.cloud.verify(NAMES[0],Path(output),r.recipient_id(self.recipient))
        self.assertFalse(any(c[0]=='purge' for c in self.calls))

    def test_calendar_buckets_cover_year_week_month_boundaries_and_choose_newest(self):
        now=datetime(2027,1,2,12,tzinfo=timezone.utc)
        names=['2026-11-30_00-00-00_UTC','2026-12-01_00-00-00_UTC','2026-12-01_01-00-00_UTC',
               '2026-12-31_00-00-00_UTC','2027-01-01_00-00-00_UTC','2027-01-02_00-00-00_UTC']
        settings={**self.settings,'pinned':[names[0]],'dailyDays':1,'weeklyWeeks':1,'monthlyMonths':3}
        local,cloud=r.choose(names,settings,now,names[-1])
        self.assertIn(names[0],cloud);self.assertIn(names[3],cloud)
        self.assertNotIn(names[1],cloud);self.assertNotIn(names[2],cloud)
        self.assertEqual(set(names[-3:])|{names[0]},local)

    def test_future_clock_and_large_delete_batches_are_rejected(self):
        with self.assertRaises(r.RetentionError):r.choose(NAMES,self.settings,NOW-timedelta(days=3),NAMES[-1])
        names=[f'2020-01-01_00-00-{i:02d}_UTC' for i in range(20)]+NAMES
        with self.assertRaisesRegex(r.RetentionError,'DELETE_SAFETY_LIMIT'):r.choose(names,self.settings,NOW,NAMES[-1])

    def test_real_command_diagnostics_remain_private_and_symlink_logs_are_rejected(self):
        log=self.state/'private-rclone.log'
        cloud=r.Cloud(log)
        result=subprocess.CompletedProcess(['rclone'],0,b'[]',b'synthetic private diagnostic')
        with patch.object(r.subprocess,'run',return_value=result):
            self.assertEqual(cloud.call(['lsjson',r.REMOTE]),b'[]')
        self.assertEqual(log.stat().st_mode&0o777,0o600)
        log.unlink();log.symlink_to(self.base/'not-a-log')
        with patch.object(r.subprocess,'run',return_value=result):
            with self.assertRaises(r.RetentionError):cloud.call(['lsjson',r.REMOTE])
        self.assertFalse((self.base/'not-a-log').exists())


if __name__=='__main__':unittest.main()
