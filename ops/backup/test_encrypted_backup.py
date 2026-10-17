import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest


spec = importlib.util.spec_from_file_location('encrypted_backup', Path(__file__).with_name('encrypted_backup.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class EncryptedBackupTests(unittest.TestCase):
    def setUp(self):
        self.age = os.environ.get('AGE_BINARY') or shutil.which('age')
        self.keygen = os.environ.get('AGE_KEYGEN_BINARY') or shutil.which('age-keygen')
        self.assertTrue(self.age and self.keygen, 'age and age-keygen are required for crypto integration tests')
        previous = os.umask(0o077)
        self.addCleanup(os.umask, previous)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.identity, self.recipients = self.generate_key('fixture')
        self.source = self.root/'source'
        self.source.mkdir()
        (self.source/'st24_db.dump').write_bytes(b'PGDMP\x00test-only-database-content')
        (self.source/'st24_files.tar.gz').write_bytes(b'test-only-files-and-config-marker')
        self.write_sums(self.source, module.COMPONENTS)
        self.encrypted = self.root/'encrypted'

    def generate_key(self, name):
        identity, recipients = self.root/(name+'.key'), self.root/(name+'.public')
        subprocess.run([self.keygen, '-o', str(identity)], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=10, check=True)
        subprocess.run([self.keygen, '-y', '-o', str(recipients), str(identity)],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, check=True)
        return identity, recipients

    def write_sums(self, directory, names):
        (directory/'SHA256SUMS.txt').write_text(''.join(
            hashlib.sha256((directory/name).read_bytes()).hexdigest()+'  '+name+'\n'
            for name in sorted(names)), encoding='ascii')

    def seal(self):
        return module.seal(self.source, self.encrypted, self.recipients, self.age)

    def test_real_age_roundtrip_keeps_only_encrypted_exports(self):
        manifest = self.seal()
        self.assertEqual(set(p.name for p in self.encrypted.iterdir()),
                         {'backup.tar.age', 'MANIFEST.json', 'SHA256SUMS.txt'})
        ciphertext = (self.encrypted/'backup.tar.age').read_bytes()
        self.assertTrue(ciphertext.startswith(b'age-encryption.org/v1\n'))
        self.assertNotIn(b'test-only-database-content', ciphertext)
        opened = self.root/'opened'
        result = module.open_set(self.encrypted, opened, self.identity, self.age)
        self.assertTrue(result['verified'])
        self.assertEqual(set(p.name for p in opened.iterdir()), module.CONTENTS)
        for name in module.CONTENTS:
            self.assertEqual((opened/name).read_bytes(), (self.source/name).read_bytes())
        self.assertEqual(manifest['recipientSha256'], module.recipient_id(self.recipients))

    def test_wrong_recovery_key_never_produces_an_extracted_dump(self):
        self.seal()
        wrong, _ = self.generate_key('wrong')
        opened = self.root/'wrong-key-output'
        with self.assertRaisesRegex(module.CryptoError, '^DECRYPTION_FAILED$'):
            module.open_set(self.encrypted, opened, wrong, self.age)
        self.assertFalse((opened/'st24_db.dump').exists())

    def test_tampering_is_rejected_even_if_outer_checksums_are_rewritten(self):
        self.seal()
        path = self.encrypted/'backup.tar.age'
        data = bytearray(path.read_bytes())
        data[-1] ^= 1
        path.write_bytes(data)
        self.write_sums(self.encrypted, module.ENCRYPTED_FILES)
        opened = self.root/'tampered-output'
        with self.assertRaisesRegex(module.CryptoError, '^DECRYPTION_FAILED$'):
            module.open_set(self.encrypted, opened, self.identity, self.age)
        self.assertFalse((opened/'st24_db.dump').exists())

    def test_bad_local_checksums_abort_before_creating_encrypted_output(self):
        (self.source/'st24_db.dump').write_bytes(b'changed-after-checksum')
        with self.assertRaisesRegex(module.CryptoError, '^CHECKSUM_MISMATCH$'):
            self.seal()
        self.assertFalse(self.encrypted.exists())

    def test_private_identity_cannot_be_mistaken_for_a_public_recipient(self):
        with self.assertRaisesRegex(module.CryptoError, '^PUBLIC_X25519_RECIPIENT_REQUIRED$'):
            module.check_recipient(self.identity, self.age)

    def test_age_validates_recipient_checksum_before_sealing(self):
        malformed = self.root/'malformed.public'
        malformed.write_text('age1'+'a'*58+'\n', encoding='ascii')
        with self.assertRaisesRegex(module.CryptoError, '^RECIPIENT_REJECTED_BY_AGE$'):
            module.check_recipient(malformed, self.age)

    def test_existing_recovery_output_is_never_overwritten(self):
        self.seal()
        opened = self.root/'existing-output'
        opened.mkdir()
        sentinel = opened/'keep.txt'
        sentinel.write_text('preserve-this-user-file')
        with self.assertRaisesRegex(module.CryptoError, '^OUTPUT_MUST_BE_EMPTY$'):
            module.open_set(self.encrypted, opened, self.identity, self.age)
        self.assertEqual(sentinel.read_text(), 'preserve-this-user-file')

    def malicious_bundle(self, kind):
        self.seal()
        bundle = self.root/'malicious.tar'
        with tarfile.open(bundle, 'w', format=tarfile.USTAR_FORMAT) as archive:
            for name in sorted(module.CONTENTS):
                item = tarfile.TarInfo(name)
                data = b'test-only-data'
                if name == 'st24_db.dump' and kind == 'link':
                    item.type = tarfile.SYMTYPE
                    item.linkname = '../outside'
                    archive.addfile(item)
                else:
                    if name == 'st24_db.dump' and kind == 'traversal':
                        item.name = '../outside'
                    item.size = len(data)
                    archive.addfile(item, io.BytesIO(data))
            if kind == 'duplicate':
                item = tarfile.TarInfo('st24_db.dump')
                item.size = 1
                archive.addfile(item, io.BytesIO(b'x'))
        with (self.encrypted/'backup.tar.age').open('wb') as file:
            subprocess.run([self.age, '--encrypt', '-R', str(self.recipients), str(bundle)],
                           stdout=file, stderr=subprocess.DEVNULL, timeout=10, check=True)
        self.write_sums(self.encrypted, module.ENCRYPTED_FILES)

    def test_recovery_rejects_symlinks_before_writing_components(self):
        self.malicious_bundle('link')
        with self.assertRaisesRegex(module.CryptoError, '^ARCHIVE_CONTENTS_INVALID$'):
            module.open_set(self.encrypted, self.root/'opened', self.identity, self.age)
        self.assertFalse((self.root/'outside').exists())

    def test_recovery_rejects_traversal_before_writing_components(self):
        self.malicious_bundle('traversal')
        with self.assertRaisesRegex(module.CryptoError, '^ARCHIVE_CONTENTS_INVALID$'):
            module.open_set(self.encrypted, self.root/'opened', self.identity, self.age)
        self.assertFalse((self.root/'outside').exists())

    def test_recovery_rejects_duplicate_archive_members(self):
        self.malicious_bundle('duplicate')
        with self.assertRaisesRegex(module.CryptoError, '^ARCHIVE_CONTENTS_INVALID$'):
            module.open_set(self.encrypted, self.root/'opened', self.identity, self.age)

    def test_checksum_manifest_rejects_unexpected_paths(self):
        sums = self.source/'SHA256SUMS.txt'
        sums.write_text('0'*64+'  ../outside\n', encoding='ascii')
        with self.assertRaisesRegex(module.CryptoError, '^CHECKSUM_MANIFEST_INVALID$'):
            module.verify_checksums(self.source, module.COMPONENTS)


if __name__ == '__main__':
    unittest.main()
