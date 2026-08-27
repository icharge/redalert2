// Objects on this layer are excluded from the normal scene pass and are only
// rendered by DarkeningComposite's separate darkness-accumulation pass. See
// Building.ts's createLamp() and DarkeningComposite.ts.
export const DARKENING_LAMP_LAYER = 31;
