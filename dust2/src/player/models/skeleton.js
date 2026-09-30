// Character skeleton. Bind pose is modelled facing +X (Source yaw 0), up +Y, right +Z, feet at
// y = 0, arms in a 45° A-pose. Every bone has an IDENTITY bind rotation, so a bone's model-space
// rotation is simply "how much its body segment is rotated away from the bind pose". That keeps
// IK / ragdoll maths trivial: local = inverse(parentModelRot) * modelRot.
import * as THREE from 'three';

const v = (x, y, z) => new THREE.Vector3(x, y, z);

// Arm geometry of the A-pose (shared by the mesh builder and the pose solver).
export const ARM = { upper: 12.4, fore: 10.6 };
export const LEG = { thigh: 16.7, calf: 16.4 };

function armChain(side) {
  const s = side === 'L' ? -1 : 1;
  const sh = v(-0.4, 56.8, 7.6 * s);
  const dU = v(0.07, -0.72, 0.69 * s).normalize();
  const el = sh.clone().addScaledVector(dU, ARM.upper);
  // forearm flexed 15° toward +X for cleaner elbow skinning
  const xp = v(1, 0, 0).addScaledVector(dU, -dU.x).normalize();
  const dF = dU.clone().multiplyScalar(Math.cos(0.26)).addScaledVector(xp, Math.sin(0.26)).normalize();
  const wr = el.clone().addScaledVector(dF, ARM.fore);
  return { sh, el, wr, dU, dF };
}
function legChain(side) {
  const s = side === 'L' ? -1 : 1;
  const hip = v(0, 36.6, 3.9 * s);
  const knee = v(0.7, 20.0, 4.4 * s);
  const ankle = v(-0.3, 3.7, 4.9 * s);
  const toe = v(5.3, 1.0, 5.6 * s);
  return { hip, knee, ankle, toe };
}

export const ARM_L = armChain('L'), ARM_R = armChain('R');
export const LEG_L = legChain('L'), LEG_R = legChain('R');

// [name, parent, bind position]
export const BONE_DEFS = [
  ['pelvis', null, v(-0.2, 38.2, 0)],
  ['spine1', 'pelvis', v(-0.6, 42.0, 0)],
  ['spine2', 'spine1', v(-0.8, 46.2, 0)],
  ['chest', 'spine2', v(-0.6, 50.6, 0)],
  ['neck', 'chest', v(0.2, 59.2, 0)],
  ['head', 'neck', v(0.9, 62.6, 0)],
  ['clav_L', 'chest', v(0.3, 57.4, -1.3)],
  ['upperarm_L', 'clav_L', ARM_L.sh],
  ['forearm_L', 'upperarm_L', ARM_L.el],
  ['hand_L', 'forearm_L', ARM_L.wr],
  ['clav_R', 'chest', v(0.3, 57.4, 1.3)],
  ['upperarm_R', 'clav_R', ARM_R.sh],
  ['forearm_R', 'upperarm_R', ARM_R.el],
  ['hand_R', 'forearm_R', ARM_R.wr],
  ['thigh_L', 'pelvis', LEG_L.hip],
  ['calf_L', 'thigh_L', LEG_L.knee],
  ['foot_L', 'calf_L', LEG_L.ankle],
  ['toe_L', 'foot_L', LEG_L.toe],
  ['thigh_R', 'pelvis', LEG_R.hip],
  ['calf_R', 'thigh_R', LEG_R.knee],
  ['foot_R', 'calf_R', LEG_R.ankle],
  ['toe_R', 'foot_R', LEG_R.toe],
];

export const BONE = {};
BONE_DEFS.forEach(([n], i) => { BONE[n] = i; });
export const NBONES = BONE_DEFS.length;
export const PARENT = BONE_DEFS.map(([, p]) => (p ? BONE[p] : -1));
export const BIND = BONE_DEFS.map(([, , p]) => p.clone());
// offset from parent joint in bind (== local position, since bind rotations are identity)
export const REST_OFS = BIND.map((p, i) => (PARENT[i] < 0 ? p.clone() : p.clone().sub(BIND[PARENT[i]])));

/** Build a THREE.Skeleton whose root bone is returned for parenting under the model root. */
export function buildSkeleton() {
  const bones = BONE_DEFS.map(([name]) => { const b = new THREE.Bone(); b.name = name; return b; });
  bones.forEach((b, i) => {
    b.position.copy(REST_OFS[i]);
    if (PARENT[i] >= 0) bones[PARENT[i]].add(b);
  });
  const inverses = BIND.map((p) => new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z));
  const skeleton = new THREE.Skeleton(bones, inverses);
  return { bones, skeleton, root: bones[0] };
}

// ---- hand frames ------------------------------------------------------------------------------
// Hands are modelled as fists around a grip in hand-local space: x = fingers (wrist -> knuckles),
// y = thumb side, z = back of the hand (mirrored for the left hand). The hole through the fist
// runs along y and is centred at GRIP_LOCAL.
export const GRIP_LOCAL = v(2.35, 0.1, -1.45);

/** Bind-pose hand frame: fingers along the forearm, thumb pointing forward (+X). */
export function handBindFrame(side) {
  const A = side === 'L' ? ARM_L : ARM_R;
  const xh = A.dF.clone();
  const yh = v(1, 0, 0).addScaledVector(xh, -xh.x).normalize();
  const zh = new THREE.Vector3().crossVectors(xh, yh);
  const mirror = side === 'L' ? -1 : 1;
  const M = new THREE.Matrix4().makeBasis(xh, yh, zh);
  // grip centre relative to the wrist, in bind (model) space
  const grip = v(GRIP_LOCAL.x, GRIP_LOCAL.y, GRIP_LOCAL.z * mirror).applyMatrix4(M);
  return { xh, yh, zh, M, mirror, grip };
}
export const HAND_L = handBindFrame('L'), HAND_R = handBindFrame('R');
