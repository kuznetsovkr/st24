import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractCdekDestinationCodeByOfficeResponse,
  isCdekOfficeBoundToQuoteDestination
} from './cdek';

test('extracts a city only from the exact CDEK office returned by lookup', () => {
  assert.equal(
    extractCdekDestinationCodeByOfficeResponse(
      [{ code: 'BRZ9', location: { city_code: 869 } }],
      'brz9'
    ),
    '869'
  );
  assert.equal(
    extractCdekDestinationCodeByOfficeResponse(
      [{ code: 'OTHER', location: { city_code: 869 } }],
      'BRZ9'
    ),
    null
  );
});

test('accepts an exact signed office code only after authoritative lookup', async () => {
  let resolverCalled = false;
  const matched = await isCdekOfficeBoundToQuoteDestination(
    'BRZ9',
    ' brz9 ',
    async () => {
      resolverCalled = true;
      return '869';
    }
  );

  assert.equal(matched, true);
  assert.equal(resolverCalled, true);
});

test('rejects an exact-looking office code that CDEK does not know', async () => {
  assert.equal(
    await isCdekOfficeBoundToQuoteDestination('869', '869', async () => null),
    false
  );
});

test('authoritatively resolves a CDEK office when quote contains a city code', async () => {
  let resolvedOffice = '';
  const matched = await isCdekOfficeBoundToQuoteDestination(
    '869',
    'BRZ9',
    async (officeCode) => {
      resolvedOffice = officeCode;
      return '869';
    }
  );

  assert.equal(matched, true);
  assert.equal(resolvedOffice, 'BRZ9');
});

test('does not accept a city-code to office-code mismatch without authoritative match', async () => {
  const matched = await isCdekOfficeBoundToQuoteDestination(
    '869',
    'BRZ9',
    async () => null
  );

  assert.equal(matched, false);
});

test('fails closed when the authoritative CDEK lookup fails', async () => {
  await assert.rejects(
    () =>
      isCdekOfficeBoundToQuoteDestination('869', 'BRZ9', async () => {
        throw new Error('cdek unavailable');
      }),
    /cdek unavailable/
  );
});
