(()=>{window.__bubble=[];for(const t of ['dragover','drop'])window.addEventListener(t,e=>window.__bubble.push({type:t,prevented:e.defaultPrevented,types:[...e.dataTransfer.types]}));return true})()
