import copy
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import legacy_migration as migration
from encrypted_backup import CryptoError
from verify_legacy_stream import verify_export


class FakeCloud:
    def __init__(self, source):
        self.sources = {p.name: {f.name: f.read_bytes() for f in p.iterdir()} for p in source.iterdir()}
        self.exports = {}
        self.uploads = 0
        self.fail_download = False

    def objects(self, root):
        return self.sources if root==migration.SOURCE_REMOTE else self.exports

    def names(self, root):
        return set(self.objects(root))

    def listing(self, root, name, expected, partial=False):
        files = self.objects(root)[name]
        if not set(files)<=expected or not partial and set(files)!=expected:
            raise migration.MigrationError('UNEXPECTED_REMOTE_SET_CONTENTS')
        return [{'name': key, 'bytes': len(value), 'time': 'fixed',
                 'hashes': {'md5': hashlib.md5(value).hexdigest()}} for key, value in sorted(files.items())]

    def download(self, root, name, directory, files):
        if root==migration.DESTINATION_REMOTE and self.fail_download:
            raise migration.RetentionError('CLOUD_OPERATION_FAILED')
        objects = self.objects(root)[name]
        if set(objects)!=files:
            raise migration.MigrationError('DOWNLOADED_CONTENTS_INVALID')
        for key, value in objects.items():
            (directory/key).write_bytes(value)
        return {key: hashlib.sha256(value).hexdigest() for key, value in objects.items()}

    def upload(self, name):
        self.uploads += 1
        incoming = {p.name: p.read_bytes() for p in (migration.ENCRYPTED/name).iterdir()}
        existing = self.exports.setdefault(name, {})
        if any(existing[key]!=value for key, value in incoming.items() if key in existing):
            raise migration.MigrationError('IMMUTABLE_CONFLICT')
        existing.update(incoming)

    def free_bytes(self):
        return 100*1024**3


class LegacyMigrationTests(unittest.TestCase):
    def setUp(self):
        previous = os.umask(0o077)
        self.addCleanup(os.umask, previous)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root/'plain'; self.source.mkdir(mode=0o700)
        self.encrypted = self.root/'encrypted'
        self.state = self.root/'state'; self.state.mkdir(mode=0o700)
        self.identity = self.root/'synthetic.key'; self.recipients = self.root/'synthetic.public'
        subprocess.run(['age-keygen','-o',str(self.identity)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        subprocess.run(['age-keygen','-y','-o',str(self.recipients),str(self.identity)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        self.patch = patch.multiple(migration,SOURCE=self.source,ENCRYPTED=self.encrypted,
                                    STATE=self.state,RECIPIENTS=self.recipients)
        self.patch.start(); self.addCleanup(self.patch.stop)
        usage = patch('legacy_migration.shutil.disk_usage')
        usage.start().return_value.free = 100*1024**3
        self.addCleanup(usage.stop)
        for name in ['2026-09-27_03-30-01','2026-10-17_03-53-02_UTC']:
            directory = self.source/name; directory.mkdir(mode=0o700)
            (directory/'st24_db.dump').write_bytes(b'PGDMP synthetic only '+name.encode())
            (directory/'st24_files.tar.gz').write_bytes(b'synthetic archive '+name.encode())
            self.sums(directory, migration.COMPONENTS)
        self.cloud = FakeCloud(self.source)
        self.originals = copy.deepcopy(self.cloud.sources)

    def sums(self, directory, files):
        (directory/'SHA256SUMS.txt').write_text(''.join(
            hashlib.sha256((directory/key).read_bytes()).hexdigest()+'  '+key+'\n' for key in sorted(files)))

    def plan(self):
        return migration.plan(self.cloud)

    def migrate(self, value=None):
        self.events = []
        return migration.migrate(self.cloud, value or self.plan(), self.events.append)

    def test_plan_only_downloads_and_checks_originals(self):
        value = self.plan()
        self.assertEqual(len(value['sets']),2)
        self.assertFalse(value['deletionSupported'])
        self.assertFalse(self.encrypted.exists())
        self.assertEqual(self.cloud.uploads,0)
        self.assertEqual(self.cloud.sources,self.originals)

    def test_real_age_roundtrip_every_legacy_set_matches_original_bytes_without_extraction(self):
        results = self.migrate()
        self.assertEqual(len(results),2)
        self.assertEqual(self.events[-1]['status'],'ok')
        self.assertFalse(self.events[-1]['originalsDeleted'])
        self.assertFalse(self.events[-1]['decryptionVerified'])
        for name in results:
            root = self.encrypted/name
            result = verify_export(root,self.identity,'age')
            self.assertTrue(result['ageAuthentication'])
            self.assertFalse(result['plaintextWritten'])
            self.assertEqual(result['componentsSha256'],{k:hashlib.sha256(v).hexdigest() for k,v in self.originals[name].items()})
            self.assertEqual({p.name for p in root.iterdir()},migration.EXPORT_FILES)
            self.assertEqual(root.stat().st_mode&0o777,0o700)
            self.assertTrue(all(p.stat().st_mode&0o777==0o600 for p in root.iterdir()))
            manifest = json.loads((root/'MANIFEST.json').read_text())
            self.assertEqual(manifest['legacySource']['backupSet'],name)
        self.assertEqual(self.cloud.sources,self.originals)
        self.assertFalse(any(p.name=='st24_db.dump' for p in self.state.rglob('*')))

    def test_rerun_reuses_ciphertext_without_reupload_or_reencrypt(self):
        plan = self.plan(); self.migrate(plan)
        before = copy.deepcopy(self.cloud.exports); uploads = self.cloud.uploads
        self.migrate(plan)
        self.assertEqual(self.cloud.uploads,uploads)
        self.assertEqual(self.cloud.exports,before)

    def test_matching_partial_upload_is_resumed_without_modifying_other_objects(self):
        plan = self.plan(); self.migrate(plan)
        name = sorted(plan['sets'])[0]
        before = copy.deepcopy(self.cloud.exports[name])
        self.cloud.exports[name].pop('MANIFEST.json')
        self.migrate(plan)
        self.assertEqual(self.cloud.exports[name],before)

    def test_existing_remote_conflict_is_not_overwritten(self):
        plan = self.plan(); self.migrate(plan)
        name = sorted(plan['sets'])[0]
        self.cloud.exports[name]['MANIFEST.json'] = b'conflicting user object'
        before = copy.deepcopy(self.cloud.exports); uploads = self.cloud.uploads
        with self.assertRaisesRegex(migration.MigrationError,'EXISTING_EXPORT_CONFLICT'):
            self.migrate(plan)
        self.assertEqual(self.cloud.exports,before)
        self.assertEqual(self.cloud.uploads,uploads)

    def test_download_failure_never_reports_verified_and_rerun_can_recover(self):
        plan = self.plan(); self.cloud.fail_download = True
        with self.assertRaises(migration.RetentionError):
            self.migrate(plan)
        self.assertFalse(any(e['status']=='ok' for e in self.events))
        self.assertEqual(self.cloud.sources,self.originals)
        self.cloud.fail_download = False
        self.migrate(plan)
        self.assertEqual(self.events[-1]['status'],'ok')

    def test_cloud_source_change_since_plan_aborts_before_any_export(self):
        plan = self.plan(); name = next(iter(plan['sets']))
        self.cloud.sources[name]['st24_db.dump'] = b'changed cloud source'
        with self.assertRaisesRegex(migration.MigrationError,'SOURCE_CHANGED_SINCE_PLAN'):
            self.migrate(plan)
        self.assertFalse(self.encrypted.exists())
        self.assertEqual(self.cloud.uploads,0)

    def test_bad_local_checksums_are_fatal(self):
        name = next(iter(self.cloud.sources))
        (self.source/name/'st24_db.dump').write_bytes(b'bad checksum')
        with self.assertRaisesRegex(CryptoError,'CHECKSUM_MISMATCH'):
            self.plan()

    def test_changed_cloud_payload_is_detected_by_fresh_download(self):
        name = next(iter(self.cloud.sources))
        self.cloud.sources[name]['st24_db.dump'] = b'wrong downloaded bytes'
        with self.assertRaisesRegex(migration.MigrationError,'CLOUD_SOURCE_MISMATCH'):
            self.plan()

    def test_names_cannot_escape_fixed_roots(self):
        for name in ['../outside','2026-09-99_03-30-01','2026-09-27_03-30-01/extra','2026-09-27_03-30-01;cmd']:
            with self.subTest(name=name),self.assertRaises((migration.MigrationError,ValueError)):
                migration.backup_name(name)

    def test_low_cloud_quota_or_local_space_never_starts_encryption(self):
        plan = self.plan()
        with patch.object(self.cloud,'free_bytes',return_value=0),self.assertRaisesRegex(migration.MigrationError,'INSUFFICIENT_MIGRATION_SPACE'):
            self.migrate(plan)
        self.assertFalse(self.encrypted.exists())
        with patch('legacy_migration.shutil.disk_usage') as usage:
            usage.return_value.free = 0
            with self.assertRaisesRegex(migration.MigrationError,'INSUFFICIENT_MIGRATION_SPACE'):
                self.migrate(plan)

    def test_wrong_plan_paths_or_key_are_not_accepted(self):
        plan = self.plan()
        for field in ['sourceRemote','destinationRemote','recipientSha256','format']:
            wrong = copy.deepcopy(plan); wrong[field]='wrong'
            with self.subTest(field=field),self.assertRaisesRegex(migration.MigrationError,'PLAN_INVALID'):
                self.migrate(wrong)
        self.assertEqual(self.cloud.uploads,0)

    def test_symlinked_plain_component_or_extra_component_is_rejected(self):
        name = next(iter(self.cloud.sources)); path = self.source/name/'st24_db.dump'
        value = path.read_bytes(); path.unlink(); path.symlink_to(self.root/'outside')
        with self.assertRaises(migration.RetentionError):self.plan()
        path.unlink();path.write_bytes(value)
        (path.parent/'unexpected').write_bytes(b'preserve me')
        with self.assertRaisesRegex(migration.MigrationError,'UNEXPECTED_LOCAL_CONTENTS'):self.plan()

    def test_remote_upload_command_is_immutable_and_never_plaintext(self):
        with patch('legacy_migration.Rclone') as transport:
            cloud = migration.LegacyCloud(self.state/'rclone.log')
            name = next(iter(self.cloud.sources)); cloud.upload(name)
            args = transport.return_value.call.call_args.args[0]
            self.assertEqual(args[:3],['copy',str(self.encrypted/name),migration.DESTINATION_REMOTE+'/'+name])
            self.assertIn('--immutable',args); self.assertIn('--checksum',args)
            self.assertNotIn(str(self.source/name),args)

    def test_stream_verification_rejects_wrong_key(self):
        self.migrate(); other = self.root/'wrong.key'
        subprocess.run(['age-keygen','-o',str(other)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        with self.assertRaises((CryptoError,tarfile.ReadError)):
            verify_export(self.encrypted/next(iter(self.cloud.sources)),other,'age')

    def test_stream_verification_checks_final_age_authentication_not_just_tar_end(self):
        self.migrate(); root = self.encrypted/next(iter(self.cloud.sources))
        self.forge_bundle(root, padding=200000)
        self.assertTrue(verify_export(root,self.identity,'age')['verified'])
        cipher = root/'backup.tar.age'; value=bytearray(cipher.read_bytes()); value[-1]^=1
        cipher.write_bytes(value); self.sums(root,migration.ENCRYPTED_FILES)
        with self.assertRaisesRegex(CryptoError,'AGE_AUTHENTICATION_FAILED'):
            verify_export(root,self.identity,'age')

    def test_stream_verification_rejects_false_provenance(self):
        self.migrate(); root = self.encrypted/next(iter(self.cloud.sources))
        path = root/'MANIFEST.json'; document=json.loads(path.read_text())
        document['legacySource']['componentsSha256']['st24_db.dump']='0'*64
        path.write_text(json.dumps(document));self.sums(root,migration.ENCRYPTED_FILES)
        with self.assertRaisesRegex(CryptoError,'DECRYPTED_SOURCE_MISMATCH'):
            verify_export(root,self.identity,'age')

    def forge_bundle(self, root, kind=None, padding=0):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer,mode='w',format=tarfile.USTAR_FORMAT) as archive:
            for name,value in sorted(self.originals[root.name].items()):
                item = tarfile.TarInfo(name);item.size=len(value)
                if name=='st24_db.dump' and kind=='symlink':
                    item.type=tarfile.SYMTYPE;item.linkname='../outside';item.size=0
                    archive.addfile(item)
                else:
                    if name=='st24_db.dump' and kind=='traversal':item.name='../outside'
                    archive.addfile(item,io.BytesIO(value))
            if kind in ('duplicate','extra'):
                item=tarfile.TarInfo('st24_db.dump' if kind=='duplicate' else 'unexpected');item.size=1
                archive.addfile(item,io.BytesIO(b'x'))
        with (root/'backup.tar.age').open('wb') as output:
            subprocess.run(['age','--encrypt','-R',str(self.recipients)],input=buffer.getvalue()+b'\0'*padding,
                           stdout=output,stderr=subprocess.DEVNULL,check=True)
        self.sums(root,migration.ENCRYPTED_FILES)

    def test_stream_verification_rejects_duplicate_extra_symlink_and_traversal(self):
        self.migrate();root=self.encrypted/next(iter(self.cloud.sources))
        for kind in ['duplicate','extra','symlink','traversal']:
            self.forge_bundle(root,kind=kind)
            with self.subTest(kind=kind),self.assertRaisesRegex(CryptoError,'ARCHIVE_CONTENTS_INVALID'):
                verify_export(root,self.identity,'age')
        self.assertFalse((self.root/'outside').exists())

    def test_cloud_read_retries_are_bounded_and_never_change_uploads(self):
        with patch('legacy_migration.Rclone') as transport,patch('legacy_migration.time.sleep') as sleep:
            cloud=migration.LegacyCloud(self.state/'rclone.log')
            transport.return_value.call.side_effect=migration.RetentionError('CLOUD_OPERATION_FAILED')
            with tempfile.TemporaryDirectory(dir=self.state) as directory:
                with self.assertRaises(migration.RetentionError):
                    cloud.download(migration.SOURCE_REMOTE,next(iter(self.cloud.sources)),Path(directory),migration.CONTENTS)
            self.assertEqual(transport.return_value.call.call_count,3)
            self.assertEqual(sleep.call_count,2)
            self.assertTrue(all(call.args[0][0]=='copy' for call in transport.return_value.call.call_args_list))

    def partial_source_download(self, root, name, directory, files):
        for key in migration.COMPONENTS:
            (directory/key).write_bytes(self.cloud.sources[name][key])
        raise migration.RetentionError('CLOUD_OPERATION_FAILED')

    def test_unreadable_checksum_fallback_preserves_explicit_warning_and_checks_all_payload_bytes(self):
        with patch.object(self.cloud,'download',side_effect=self.partial_source_download):
            plan=self.plan()
        self.assertTrue(all(row['sourceRead']['mode']=='payloads-downloaded-checksum-local' for row in plan['sets'].values()))
        self.migrate(plan)
        self.assertEqual(self.events[-1]['sourceChecksumReadWarnings'],2)
        for name in plan['sets']:self.assertTrue(verify_export(self.encrypted/name,self.identity,'age')['verified'])
        self.assertEqual(self.cloud.sources,self.originals)

    def test_checksum_fallback_rejects_payload_mismatch_or_checksum_metadata_mismatch(self):
        name=next(iter(self.cloud.sources))
        with patch.object(self.cloud,'download',side_effect=self.partial_source_download):
            self.cloud.sources[name]['st24_db.dump']=b'wrong actual payload'
            with self.assertRaisesRegex(migration.MigrationError,'CLOUD_SOURCE_PAYLOAD_MISMATCH'):self.plan()
            self.cloud.sources=copy.deepcopy(self.originals)
            self.cloud.sources[name]['SHA256SUMS.txt']=b'wrong metadata'
            with self.assertRaisesRegex(migration.MigrationError,'UNREADABLE_CHECKSUM_METADATA_MISMATCH'):self.plan()

    def test_unreadable_payload_is_never_replaced_by_local_bytes(self):
        def failed(root,name,directory,files):
            (directory/'SHA256SUMS.txt').write_bytes(self.cloud.sources[name]['SHA256SUMS.txt'])
            (directory/'st24_files.tar.gz').write_bytes(self.cloud.sources[name]['st24_files.tar.gz'])
            raise migration.RetentionError('CLOUD_OPERATION_FAILED')
        with patch.object(self.cloud,'download',side_effect=failed),self.assertRaises(migration.RetentionError):
            self.plan()

    def test_busy_lock_is_read_only_and_does_not_replace_another_workers_status(self):
        lock=self.root/'backup.lock';lock.write_text('')
        status=self.state/'last-run.json';status.write_text('{"status":"running"}\n')
        before=status.read_bytes();real_open=open
        def open_lock(path,mode):
            self.assertEqual(path,'/var/lock/st24-backup.lock')
            self.assertEqual(mode,'r')
            return real_open(lock,'r')
        with real_open(lock,'r') as held:
            fcntl.flock(held,fcntl.LOCK_EX|fcntl.LOCK_NB)
            for mode in ['plan','migrate']:
                with patch('legacy_migration.open',side_effect=open_lock,create=True), \
                     patch('legacy_migration.protected'), \
                     patch('legacy_migration.os.geteuid',return_value=0), \
                     patch.object(sys,'argv',['legacy_migration.py',mode]):
                    self.assertEqual(migration.main(),75)
                self.assertEqual(status.read_bytes(),before)


if __name__=='__main__':
    unittest.main()
