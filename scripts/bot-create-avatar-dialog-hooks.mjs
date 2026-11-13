import './bot-create-avatar-ui-hooks.mjs';
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
registerHooks({resolve(specifier,context,next){if(specifier==='@/store/appStore')return {url:pathToFileURL(resolve(process.env.TSGO_UI_COMPILED,'scripts/bot-create-avatar-store-fixture.js')).href,shortCircuit:true};return next(specifier,context);}});
