/**
 * Build 6: what an install card must say about the instance it pairs. A system that hosts installs (fs) can't see the
 * hub's instances, so the hub checks its own before anyone is asked: installing under a name the hub already has
 * paired hands the new code that instance's key, config secrets, connections and visibility. Such a card is refused
 * unless the run asked to replace it (`replace: true` in its args); then the hub writes what it replaces into the
 * subject and at the top of the card, so the admin sees it and the pairing grant is bound to it (`StorePairingService.grant`).
 * The card also gets what the install's contract changes over the one the hub has (`ApprovalPreview.summary`), worked
 * out as a pending review's is, from the contract the host sent with it, which must be the one the subject binds.
 */
import { instanceLabel, type ApprovalPreview, type InstallSubject, type InstanceRecord, type InstanceRef, type Json, type Manifest, type PreviewAnswer, type SystemName } from '@harness/core';
import { contractHash } from '@harness/sdk';
import { contractChanges } from './lifecycle.ts';
import { reviewSummary } from './review-summary.ts';

/** A system's contract as the hub has it now (`Catalog.manifest`). */
export type ManifestLookup = (system: SystemName) => Promise<Manifest | undefined>;

/** An instance row by name (`InstanceKeeper.get`). */
export type InstanceLookup = (ref: InstanceRef) => Promise<InstanceRecord | undefined>;

/** The paired instance an install subject would take over, if any (a removed one is free to take). */
export async function pairedInstance(subject: Pick<InstallSubject, 'system' | 'instance'>, lookup: InstanceLookup): Promise<InstanceRecord | undefined> {
  const existing = await lookup({ system: subject.system, instance: subject.instance });
  return existing === undefined || existing.status === 'removed' ? undefined : existing;
}

/** Whether an existing instance is the one the subject's host runs now (an update of its own install). */
function hostedBy(existing: InstanceRecord, subject: InstallSubject): boolean {
  return existing.host?.host.system === subject.host.system && existing.host.host.instance === subject.host.instance;
}

/** Whether a run's args ask to replace a system that runs somewhere else (`replace: true`). */
function asksToReplace(args: Json | undefined): boolean {
  return typeof args === 'object' && args !== null && !Array.isArray(args) && args['replace'] === true;
}

/**
 * An install card checked against the hub's instances: as it was when the name is free or the host updates its own
 * install; with the instance it replaces written into its subject, title and first part when the run asked to
 * replace; else why not, said to the model as invalid input.
 */
export async function checkedInstall(preview: ApprovalPreview, args: Json | undefined, lookup: InstanceLookup): Promise<{ preview: ApprovalPreview } | { refused: string }> {
  const subject = preview.subject;
  if (subject?.kind !== 'system-install') return { preview };
  const existing = await pairedInstance(subject, lookup);
  if (existing === undefined || (subject.replaces !== undefined && hostedBy(existing, subject))) return { preview };
  const label = instanceLabel(existing);
  if (!asksToReplace(args)) {
    return { refused: `${label} is already paired (version ${existing.version}, ${existing.status}). Pick another instance name, or call again with replace: true to replace it (the card then says so).` };
  }
  const replaces = { version: existing.version, manifestHash: existing.manifestHash === '' ? 'none' : existing.manifestHash };
  const where = existing.host === undefined ? 'not hosted by the hub' : `hosted by ${instanceLabel(existing.host.host)}`;
  return {
    preview: {
      ...preview,
      title: `Replace ${label} ${existing.version} with ${subject.version} on ${instanceLabel(subject.host)}`,
      subject: { ...subject, replaces },
      parts: [
        { type: 'text', text: `**Replaces ${label}** (version ${existing.version}, ${existing.status}, ${where}). The new code takes over its key, config and secrets, connections and who may use it.` },
        ...preview.parts,
      ],
    },
  };
}

/**
 * An install card with what its contract changes over the system's contract in the hub (all of it added, for a new
 * system), as the review page would list it once paired. The contract the host sent must be the one the subject
 * binds; it is never stored. A card without a subject, or without a contract (a host from before), is as it came.
 */
export async function summarizedInstall(preview: ApprovalPreview, contract: Manifest | undefined, manifestOf: ManifestLookup): Promise<{ preview: ApprovalPreview } | { refused: string }> {
  const subject = preview.subject;
  if (subject?.kind !== 'system-install' || contract === undefined) return { preview };
  // the hub hashes the contract itself (`contractHash`, what the pairing grant binds), so a host can't send another
  if (contract.name !== subject.system || await contractHash(contract) !== subject.manifestHash) {
    return { refused: `The contract sent with the card is not the one it installs (${subject.system}, ${subject.manifestHash}): call install_system again.` };
  }
  const before = await manifestOf(subject.system);
  return { preview: { ...preview, summary: reviewSummary(contractChanges(before, contract)) } };
}

/** The install checks of a preview answer, in order: the instance it pairs (`checkedInstall`), then its summary (`summarizedInstall`). */
export async function installCard(answer: PreviewAnswer, args: Json | undefined, lookups: { readonly instance: InstanceLookup; readonly manifest: ManifestLookup }): Promise<{ preview: ApprovalPreview } | { refused: string }> {
  if (!('preview' in answer)) return answer;
  const checked = await checkedInstall(answer.preview, args, lookups.instance);
  return 'preview' in checked ? await summarizedInstall(checked.preview, answer.contract, lookups.manifest) : checked;
}
