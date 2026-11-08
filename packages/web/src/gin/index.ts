/**
 * The gin editors and viewers: one component per concern, each an editor or a viewer by its `readonly` flag. A
 * value of a gin type (`GinValueView`), a gin type (`GinTypeView`), a gin expression (`GinExprView`), and a whole
 * form with Submit (`GinForm`). Systems' components for their named types take over through `GIN_INPUTS`.
 */
export { default as GinExprView } from './GinExprView.vue';
export { default as GinForm } from './GinForm.vue';
export { default as GinTypeView } from './GinTypeView.vue';
export { default as GinValueView } from './GinValueView.vue';
export { drawerFor, GIN_INPUTS, NO_INPUTS, type CustomInput, type InputLookup, type ValueDrawer } from './registry.ts';
export { GIN_TYPES, LOCAL_TYPES, TypeLibrary, type TypeSource } from './types.ts';
