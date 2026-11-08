/** Signing out from anywhere in the app, and leaving for sign-in when the sign-in ends on its own. */
import { watch } from 'vue';
import { useRouter } from 'vue-router';
import { useStores } from '../state/stores.ts';
import { links } from './routes.ts';

/**
 * A function that signs out and loads the sign-in page fresh, so the socket (which keeps the token it connected with)
 * and every cache start over signed out.
 */
export function useSignOut(): () => Promise<void> {
  const { keeper } = useStores();
  const router = useRouter();
  return async () => {
    await keeper.signOut();
    window.location.replace(router.resolve(links.signIn()).href);
  };
}

/**
 * When the session ends without the person signing out here (the hub refused its tokens, or another tab signed out),
 * load the sign-in page fresh with the way back to where they were, so the socket and every cache start over. Call
 * once, in the root.
 */
export function useLeaveWhenSignedOut(): void {
  const { session } = useStores();
  const router = useRouter();
  watch(session.signedIn, (signedIn) => {
    const here = router.currentRoute.value;
    if (signedIn || here.meta.public === true) { return; }
    window.location.replace(router.resolve(links.signIn(here.fullPath)).href);
  });
}
