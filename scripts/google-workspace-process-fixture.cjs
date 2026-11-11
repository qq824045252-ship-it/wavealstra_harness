if (process.argv[2] === 'success') process.stdout.write('[]');
else if (process.argv[2] === 'large') process.stdout.write('x'.repeat(8192));
else if (process.argv[2] === 'hang') setInterval(() => {}, 1000);
else process.exitCode = 1;
