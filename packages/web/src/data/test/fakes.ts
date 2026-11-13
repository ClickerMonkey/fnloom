/** Test doubles for the Data pages: callers that answer with the samples, and record what they were asked. */
import { fakeCaller } from '../../test/fakes.ts';
import { SAMPLE_ACTIONS, SAMPLE_RECORDS, SAMPLE_RECORD_TABLE, SAMPLE_SETS, sampleItemVersions, sampleRecordVersions } from './samples.ts';

/** The data callers, answering with the samples. */
export function fakeDataApi() {
  return {
    dataSets: fakeCaller<'dataSets'>(() => Promise.resolve({ items: [...SAMPLE_SETS] })),
    records: fakeCaller<'records'>(() => Promise.resolve({ items: [...SAMPLE_RECORDS] })),
    recordTable: fakeCaller<'recordTable'>(() => Promise.resolve(SAMPLE_RECORD_TABLE)),
    record: fakeCaller<'record'>((body) => {
      const record = SAMPLE_RECORDS.find((r) => r.id === body.id);
      return Promise.resolve(record === undefined ? {} : { record });
    }),
    saveRecord: fakeCaller<'saveRecord'>((body) => {
      const known = SAMPLE_RECORDS.find((r) => r.id === body.id) ?? SAMPLE_RECORDS[0];
      if (known === undefined) { return Promise.reject(new Error('no sample')); }
      return Promise.resolve({ ...known, value: body.value, version: known.version + 1 });
    }),
    updateRecord: fakeCaller<'updateRecord'>((body) => {
      const known = SAMPLE_RECORDS.find((r) => r.id === body.id);
      if (known === undefined) { return Promise.reject(new Error('no sample')); }
      const value = typeof known.value === 'object' && known.value !== null && !Array.isArray(known.value) ? known.value : {};
      return Promise.resolve({ ...known, value: { ...value, ...body.set }, version: known.version + 1 });
    }),
    removeRecord: fakeCaller<'removeRecord'>(() => Promise.resolve({ removed: true })),
    recordVersions: fakeCaller<'recordVersions'>((body) => {
      const record = SAMPLE_RECORDS.find((r) => r.id === body.id);
      return Promise.resolve({ items: record === undefined ? [] : sampleRecordVersions(record) });
    }),
    rowActions: fakeCaller<'rowActions'>(() => Promise.resolve([...SAMPLE_ACTIONS])),
    readFn: fakeCaller<'readFn'>(() => Promise.resolve(null)),
    exportCsv: fakeCaller<'export'>(() => Promise.resolve(new Blob(['title,words\r\nPlan the trip,6\r\n']).stream())),
    itemVersions: fakeCaller<'itemVersions'>((body) => Promise.resolve({ items: sampleItemVersions(body.system, body.section, body.name) })),
  };
}
