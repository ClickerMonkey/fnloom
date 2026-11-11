/** Test doubles for the graph views: the graph caller answering from the sample graph the way the hub does. */
import { GraphQuery } from '@harness/core';
import { fakeCaller } from '../../test/fakes.ts';
import { graphOf } from './graph.ts';

/** The graph caller, answering from the sample graph. */
export function fakeGraphApi() {
  return {
    graph: fakeCaller<'graph'>((query) => Promise.resolve().then(() => graphOf(GraphQuery.parse(query ?? {})))),
  };
}
