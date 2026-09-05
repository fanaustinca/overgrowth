// Shared world curvature.
//
// On a flat plane the three forks the player is supposed to be reading get
// crushed into a few dozen pixels at the skyline. Bending geometry upward in
// view space - the standard endless-runner trick - gives distant track real
// vertical spread and rolls the horizon out of frame entirely. It is purely
// visual: the simulation never sees it, so collisions stay honest.
//
// Every world-space vertex shader includes this chunk and pipes its view-space
// position through curveView() before projection.
export const CURVE_CHUNK = `
const float WORLD_CURVE = 0.0016;
vec4 curveView(vec4 mv){
  mv.y += WORLD_CURVE * mv.z * mv.z;
  return mv;
}
`;
