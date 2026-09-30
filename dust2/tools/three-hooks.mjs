const base = new URL('../vendor/three/', import.meta.url);
export async function resolve(spec, ctx, next) {
  if (spec === 'three') return { url: new URL('build/three.module.js', base).href, shortCircuit: true };
  if (spec.startsWith('three/addons/')) return { url: new URL('jsm/' + spec.slice(13), base).href, shortCircuit: true };
  return next(spec, ctx);
}
