// Test-only probe: observe the actual decoder interpretation, deliberately without application preflight.
import {parentPort,workerData} from 'node:worker_threads';
import * as photon from '@silvia-odwyer/photon-node';
let image;
try {image=photon.PhotonImage.new_from_byteslice(workerData.bytes);parentPort.postMessage({width:image.get_width(),height:image.get_height()});}
catch {parentPort.postMessage({error:true});}
finally {image?.free();}
