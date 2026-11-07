const test=require('node:test');
const assert=require('node:assert/strict');
const NativeDatabase=require('better-sqlite3');
const {Database,configureStorage}=require('../workers/sqlite');

function database(t) {
  const native=new NativeDatabase(':memory:');
  t.after(()=>native.close());
  const calls=[];
  configureStorage({
    sql:{exec(sql,...args) {
      calls.push({sql,args});
      const statement=native.prepare(sql);
      const rows=statement.reader ? statement.all(...args) : (statement.run(...args),[]);
      return {toArray:()=>rows,one:()=>{assert.equal(rows.length,1);return rows[0];}};
    }},
    transactionSync:callback=>native.transaction(callback)(),
  });
  return {db:new Database(),calls};
}

test('Workers SQL expands repeated named parameters in SQL order, not object key order',t=>{
  const {db,calls}=database(t);
  const row=db.prepare('SELECT @second AS a, @first AS b, @second AS c, :third AS d, $last AS e').get({last:4,third:3,first:1,second:2});
  assert.deepEqual(row,{a:2,b:1,c:2,d:3,e:4});
  assert.deepEqual(calls[0].args,[2,1,2,3,4]);
  assert.equal(calls[0].sql,'SELECT ? AS a, ? AS b, ? AS c, ? AS d, ? AS e');
});
test('Workers SQL does not bind names in strings, quoted identifiers, or comments',t=>{
  const {db,calls}=database(t);
  const row=db.prepare(`SELECT '@literal' AS "@identifier", ':it''s' AS [@bracket], @value AS \`$column\` -- @line\n /* :block */`).get({value:7});
  assert.deepEqual(row,{'@identifier':'@literal','@bracket':":it's",'$column':7});
  assert.deepEqual(calls[0].args,[7]);
});
test('Workers SQL preserves positional, undefined, binary and parameter-free calls',t=>{
  const {db}=database(t);
  assert.deepEqual(db.prepare('SELECT ? AS a, ? AS b').get(3,undefined),{a:3,b:null});
  assert.equal(db.prepare('SELECT hex(?) AS value').get(Buffer.from([1,2])).value,'0102');
  assert.equal(db.prepare('SELECT 1 AS count').get({search:''}).count,1);
  assert.equal(db.prepare('SELECT 1 AS count').get({}).count,1);
  assert.throws(()=>db.prepare('SELECT @required').get({}),/Missing named SQL parameter/);
});
test('Workers SQL binds named UPDATE parameters through run()',t=>{
  const {db}=database(t);
  db.exec('CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT)');
  assert.equal(db.prepare('INSERT INTO sample VALUES (@id,@value)').run({value:'before',id:1}).changes,1);
  db.prepare('UPDATE sample SET value=@value WHERE id=@id').run({id:1,value:'after'});
  assert.equal(db.prepare('SELECT value FROM sample WHERE id=@id').get({'@id':1}).value,'after');
});
test('Worker user repository searches and counts correctly with and without filters',t=>{
  const {db}=database(t);
  db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, name TEXT)');
  db.exec('CREATE TABLE traffic_user_total(user_id INTEGER, total_up INTEGER, total_down INTEGER)');
  for(const row of [[1,'alice','First'],[2,'bob','Alice display'],[3,'other','Third']]) db.prepare('INSERT INTO users VALUES (?,?,?)').run(...row);
  const repo=require('../src/services/repos/userRepo');repo.init({getDb:()=>db});
  assert.equal(repo.getAllUsersPaged(1,1).total,3);
  assert.equal(repo.getAllUsersPaged(1,1).rows.length,1);
  assert.equal(repo.getAllUsersPaged(20,0,'alice').total,2);
  assert.equal(repo.getAllUsersPaged(20,0,'alice').rows.length,2);
});
