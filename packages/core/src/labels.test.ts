import { describe, expect, it } from 'vitest';
import { actionLabel, humanize, labelFor } from './index.ts';

describe('humanize', () => {
  it.each([
    // snake, camel, kebab and spaced names read as words, in sentence case
    ['title', 'Title'],
    ['due_date', 'Due date'],
    ['createdAt', 'Created at'],
    ['created-at', 'Created at'],
    ['created at', 'Created at'],
    ['read_file', 'Read file'],
    ['readFile', 'Read file'],
    ['TotalAmount', 'Total amount'],
    ['__private_field__', 'Private field'],
    ['due__date', 'Due date'],
    // acronyms in capitals wherever they are
    ['id', 'ID'],
    ['ID', 'ID'],
    ['Id', 'ID'],
    ['user_id', 'User ID'],
    ['userId', 'User ID'],
    ['userID', 'User ID'],
    ['ids', 'IDs'],
    ['user_ids', 'User IDs'],
    ['avatar_url', 'Avatar URL'],
    ['avatarURL', 'Avatar URL'],
    ['api_key', 'API key'],
    ['json_body', 'JSON body'],
    ['export_csv', 'Export CSV'],
    ['uuid', 'UUID'],
    ['ip_address', 'IP address'],
    ['HTTPServer', 'HTTP server'],
    ['parseHTTPResponse', 'Parse HTTP response'],
    ['urls', 'URLs'],
    // words that only look like acronyms stay words
    ['status', 'Status'],
    ['ideas', 'Ideas'],
    ['idle', 'Idle'],
    ['video_id', 'Video ID'],
    // screaming case is lowered first; a lone all-caps word stays (it may be an acronym)
    ['TOTAL_COUNT', 'Total count'],
    ['USER_ID', 'User ID'],
    ['NASA', 'NASA'],
    // dotted and slashed paths read as their parts
    ['Entry.reveal', 'Entry reveal'],
    ['address.city', 'Address city'],
    ['customer.address.zip_code', 'Customer address zip code'],
    ['owner.id', 'Owner ID'],
    ['fs/read_file', 'Fs read file'],
    // digits stay with their word
    ['address2', 'Address2'],
    ['line2Total', 'Line2 total'],
    ['q4_sales', 'Q4 sales'],
    // nothing to say
    ['', ''],
    ['_', '_'],
  ])('%s → %s', (name, words) => {
    expect(humanize(name)).toBe(words);
  });
});

describe('labelFor', () => {
  it('keeps an explicit label as it is and humanizes a bare name', () => {
    expect(labelFor({ name: 'due_date' })).toBe('Due date');
    expect(labelFor({ name: 'due_date', label: 'when it is due' })).toBe('when it is due');
    expect(labelFor({ name: 'owner_id', label: undefined })).toBe('Owner ID');
  });
});

describe('actionLabel', () => {
  it('names a method by its last part, humanized', () => {
    expect(actionLabel('todo/Task.mark_done')).toBe('Mark done');
    expect(actionLabel('fs/Entry.reveal')).toBe('Reveal');
    expect(actionLabel('owner_id')).toBe('Owner ID');
    expect(actionLabel('MarkDone')).toBe('Mark done');
    expect(actionLabel('fs/')).toBe('fs/');
  });
});
