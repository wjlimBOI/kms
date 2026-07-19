const { Pool } = require('pg');
const bcrypt = require('bcrypt');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function test() {
    const res = await pool.query('SELECT username, password_hash FROM users WHERE username = $1', ['project']);
    if (res.rows.length === 0) {
        console.log('User not found');
        return;
    }
    const user = res.rows[0];
    const match = await bcrypt.compare('admin123', user.password_hash);
    console.log('Password match:', match);
    await pool.end();
}
test();