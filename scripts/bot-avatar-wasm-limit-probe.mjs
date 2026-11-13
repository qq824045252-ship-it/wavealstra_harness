// Test-only: exercise the actual avatar-specific WASM instance's enforced memory ceiling.
import {parentPort,workerData} from 'node:worker_threads';
import * as photon from '@silvia-odwyer/photon-node';
const memory=photon.__wasm.memory,before=memory.buffer.byteLength;
let rejected=false,image;
try{memory.grow(2048-before/65536+1);}catch(error){rejected=error instanceof RangeError;}
const atomic=memory.buffer.byteLength===before;
try {
 image=photon.PhotonImage.new_from_byteslice(workerData.bytes);
 parentPort.postMessage({growthRejected:rejected,growthWasAtomic:atomic,width:image.get_width(),height:image.get_height()});
} finally {image?.free();}
