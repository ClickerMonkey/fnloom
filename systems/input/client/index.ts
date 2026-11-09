/**
 * The input system's renderers: every input fn, and every saved form (the `form` kind), is drawn as the form card.
 * Each renderer is a functional component typed by its own fn's view that hands the card what it reads.
 */
import type { FnError, RunId } from '@harness/core';
import { client, type FnView, type FnViewOf, type SystemClient, type UntypedFn, type WithSystem } from '@harness/sdk';
import { h, type FunctionalComponent } from 'vue';
import { input, type InputContract } from '../shared/index.ts';
import FormCard from './FormCard.vue';

/** A renderer drawing a run of any input fn as its form. */
function formView<P extends { run: RunId; result?: unknown; error?: FnError; system: SystemClient<InputContract['defs']> }>(): FunctionalComponent<P> {
  return (props) => h(FormCard, { run: props.run, result: props.result, error: props.error, system: props.system });
}

type Ask<K extends keyof InputContract['defs']['fns']> = FnViewOf<typeof input, K>;

export default client(input, {
  fns: {
    get_input: formView<Ask<'get_input'>>(),
    ask_text: formView<Ask<'ask_text'>>(),
    ask_choice: formView<Ask<'ask_choice'>>(),
    ask_confirm: formView<Ask<'ask_confirm'>>(),
    ask_number: formView<Ask<'ask_number'>>(),
    ask_date: formView<Ask<'ask_date'>>(),
  },
  kinds: { form: formView<FnView<UntypedFn> & WithSystem<InputContract['defs']>>() },
});
