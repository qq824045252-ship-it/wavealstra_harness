JSON.stringify({errors:[...document.querySelectorAll('[class*=error]')].map(e=>e.textContent),text:document.querySelector('aside')?.textContent})
