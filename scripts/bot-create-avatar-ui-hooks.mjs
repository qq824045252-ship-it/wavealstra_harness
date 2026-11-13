import './gateway-ui-hooks.mjs';
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
registerHooks({resolve(specifier,context,next){if(specifier==='@/lib/botAvatarAssets')return {url:pathToFileURL(resolve(process.env.TSGO_UI_COMPILED,'scripts/bot-avatar-ui-assets.js')).href,shortCircuit:true};return next(specifier,context);}});
