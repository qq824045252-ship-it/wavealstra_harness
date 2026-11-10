// Browser API used at store initialization; DOM-only regression has no media engine.
window.matchMedia ??= (() => ({matches:false,media:'',onchange:null,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){},dispatchEvent(){return true;}})) as typeof window.matchMedia;
