/**
 * The fake hub's data system keeps to the same ownership rules as the hub: a person-owned type is read and written
 * only in a run (as its person), and one person's records are hidden from another.
 */
import { describe, expect, it } from 'vitest';
import { ActorId, QualifiedName, RunId, TypeDecl, type ListQuery } from '@harness/core';
import { FakeRecords, type StoredTypeDecl } from './fake-records.ts';

const NOTE = QualifiedName.parse('notes/Note');
const RUN = RunId.parse('run_1');
const ANN = ActorId.parse('act_ann');
const BOB = ActorId.parse('act_bob');
const ALL: ListQuery = { limit: 10 };

const decl: StoredTypeDecl = {
  ...TypeDecl.parse({ name: 'Note', description: 'A note.', def: { name: 'obj', props: { title: { type: { name: 'text' } } } }, display: { label: 'Note' }, methods: [] }),
  records: { shape: 'table', owner: 'person', search: { text: ['title'], embed: false } },
};

/** A fake whose run acts for whoever `as.actor` names. */
function fake() {
  const as = { actor: ANN };
  const records = new FakeRecords((name) => (name === NOTE ? decl : undefined), () => as.actor);
  return { records, as };
}

describe('person-owned records on the fake hub', () => {
  it('lets the system keep every record of its own types outside a run, keeping each owner', () => {
    const { records, as } = fake();
    const ann = records.save({ type: NOTE, value: { title: 'Ann note' }, run: RUN });
    as.actor = BOB;
    expect(records.find({ type: NOTE, query: ALL }).items.map((record) => record.id)).toEqual([ann.id]);
    expect(records.save({ type: NOTE, id: ann.id, value: { title: 'done' } }).owner).toBe(ANN);
  });

  it('hides one person\'s records from another', () => {
    const { records, as } = fake();
    const ann = records.save({ type: NOTE, value: { title: 'Ann\'s' }, run: RUN });
    expect(records.get({ type: NOTE, id: ann.id, run: RUN }).record?.owner).toBe(ANN);
    as.actor = BOB;
    expect(records.find({ type: NOTE, query: ALL, run: RUN }).items).toEqual([]);
    expect(records.get({ type: NOTE, id: ann.id, run: RUN })).toEqual({});
    expect(() => records.save({ type: NOTE, id: ann.id, value: { title: 'mine now' }, run: RUN })).toThrow(/No notes\/Note record/);
  });
});
