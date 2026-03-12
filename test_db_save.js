import { saveMessage } from './db.js';

saveMessage('test_session', 'user', 'hello')
    .then(id => console.log('Success, ID:', id))
    .catch(err => {
        console.error('Database Error:', err);
        process.exit(1);
    });
