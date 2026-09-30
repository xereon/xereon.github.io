// Aggregates every non-crate prop builder. Each builder returns { parts, colliders, userData }.
import { doubleDoor, bigDoorMetal, windowShutters, shopShutter, windowGrate } from './door.js';
import { barrel, jerrycan, metalCrate, electricBox, meterBox, acUnit, satelliteDish, lamp, pipe } from './metal.js';
import { tarp, tarpCrate, awning, sandbags, hangingRope, wireSpan } from './cloth.js';
import { pallet, bench, ladder, woodenBeam, slatCrate, plankFence, utilityPole } from './wood.js';
import { palm, plant, rubble, urn, stoneBlocks, stoneBench, archKeystone } from './nature.js';
import { car, tire, tyreStack } from './car.js';

export const BUILDERS = {
  doubleDoor, bigDoorMetal, windowShutters, shopShutter, windowGrate,
  barrel, jerrycan, metalCrate, electricBox, meterBox, acUnit, satelliteDish, lamp, pipe,
  tarp, tarpCrate, awning, sandbags, hangingRope, wireSpan,
  pallet, bench, ladder, woodenBeam, slatCrate, plankFence, utilityPole,
  palm, plant, rubble, urn, stoneBlocks, stoneBench, archKeystone,
  car, tire, tyreStack,
};
