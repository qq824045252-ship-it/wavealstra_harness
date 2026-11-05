JSON.stringify([...document.querySelectorAll('.task-item:not(.nested)')].map(e=>({title:e.title,text:e.textContent,rect:e.getBoundingClientRect().toJSON()})))
