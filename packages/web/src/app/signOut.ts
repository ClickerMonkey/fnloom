/** Signing out from anywhere in the app. */
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
