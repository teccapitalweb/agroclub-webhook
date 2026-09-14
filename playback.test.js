const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const lessonAccess=require('./lesson-access');
const source=fs.readFileSync(require.resolve('./server.js'),'utf8');
const block=source.slice(source.indexOf('async function autorizarClaseGratuita'),source.indexOf('// Devuelve una URL efímera'));
function fixture(courses){
  const state={courses};
  const context={lessonAccess,db:{collection:()=>({get:async()=>({docs:state.courses.map(c=>({id:c.id,data:()=>c}))})})}};
  vm.createContext(context);vm.runInContext(block,context);
  return {state,authorize:context.autorizarClaseGratuita};
}
test('actual endpoint authorization validates course, lesson and video, with no stale grant',async()=>{
  const f=fixture([{id:'first',orden:1,clases:[{num:1,videoId:'free-1'},{num:2,videoId:'free-2'},{num:3,videoId:'last'}]},{id:'other',orden:2,clases:[{num:1,videoId:'other'}]}]);
  assert.equal(await f.authorize('first',1,'free-1'),true);
  assert.equal(await f.authorize('first',2,'free-2'),true);
  assert.equal(await f.authorize('first',3,'last'),false);
  assert.equal(await f.authorize('other',1,'other'),false);
  assert.equal(await f.authorize('first',1,'last'),false);
  assert.equal(await f.authorize(undefined,1,'free-1'),false);
  assert.equal(await f.authorize(undefined,undefined,'free-1'),true);
  assert.equal(await f.authorize(undefined,undefined,'last'),false);
  assert.equal(await f.authorize(undefined,undefined,'other'),false);
  f.state.courses[0].clases.splice(1); // previously free lesson becomes final immediately
  assert.equal(await f.authorize('first',1,'free-1'),false);
});
test('a free video reused by a paid lesson is not signed for free users',async()=>{
  const f=fixture([{id:'first',orden:1,clases:[{num:1,videoId:'same'},{num:2,videoId:'same'}]}]);
  assert.equal(await f.authorize('first',1,'same'),false);
});

const identityBlock=source.slice(source.indexOf('async function accesoParaReproduccion'),source.indexOf('// The first active course'));
const driveStart=source.indexOf("app.post('/api/lesson-playback'");
const driveBlock=source.slice(driveStart,source.indexOf('// ═════════',driveStart));
function driveFixture(courses,{paid=false,admin=false}={}){
  let handler;
  const context={lessonAccess,console:{error(){}},
    app:{post:(_path,fn)=>{handler=fn;}},
    auth:{verifyIdToken:async token=>{if(token!=='valid'){const err=new Error('Invalid fixture token');err.code='auth/invalid-token';throw err;}return{uid:'qa-user'};}},
    db:{collection:name=>name==='admins'?{doc:()=>({get:async()=>({exists:admin})})}:{get:async()=>({docs:courses.map(c=>({id:c.id,data:()=>c}))})}},
    obtenerMembresia:async()=>paid?{estado:'activo'}:{},fechaVigente:()=>false
  };
  vm.createContext(context);vm.runInContext(identityBlock+'\n'+driveBlock,context);
  return async(body,authorization='Bearer valid')=>{
    let status=200,payload;
    const res={setHeader(){},status(n){status=n;return this;},json(value){payload=value;return this;}};
    await handler({headers:{authorization},body},res);return{status,body:payload};
  };
}
const driveCourses=[{id:'first',orden:1,clases:[{num:1,driveId:'drive-first-1'},{num:2,driveId:'drive-first-2'},{num:3,driveId:'drive-last'}]},
  {id:'other',orden:2,clases:[{num:1,driveId:'drive-other-1'},{num:2,driveId:'drive-other-2'}]}];
test('Drive playback: first two classes free, final and other courses paid, admin retained',async()=>{
  const request=driveFixture(driveCourses);
  for(const n of [1,2]){
    const result=await request({courseId:'first',lessonNumber:n,driveId:'client-cannot-select-this',embedUrl:'https://invalid.example/video'});
    assert.equal(result.status,200);
    assert.equal(result.body.embedUrl,`https://drive.google.com/file/d/drive-first-${n}/preview`);
  }
  assert.equal((await request({courseId:'first',lessonNumber:3})).status,403);
  assert.equal((await request({courseId:'other',lessonNumber:1})).status,403);
  assert.equal((await driveFixture(driveCourses,{paid:true})({courseId:'first',lessonNumber:3})).status,200);
  assert.equal((await driveFixture(driveCourses,{paid:true})({courseId:'other',lessonNumber:2})).status,200);
  assert.equal((await driveFixture(driveCourses,{admin:true})({courseId:'first',lessonNumber:3})).status,200);
});
test('Drive playback validates session, existing lesson identity and malformed indices',async()=>{
  const request=driveFixture(driveCourses);
  assert.equal((await request({courseId:'first',lessonNumber:1},'')).status,401);
  assert.equal((await request({courseId:'first',lessonNumber:1},'Bearer wrong')).status,401);
  for(const n of [undefined,null,'',-1,1.5,{},[1],'abc'])assert.equal((await request({courseId:'first',lessonNumber:n})).status,400);
  assert.equal((await request({courseId:'unknown',lessonNumber:1})).status,404);
  assert.equal((await request({courseId:'first',lessonNumber:99})).status,404);
  assert.equal((await request({courseId:'first',lessonNumber:'2'})).status,200);
  const hidden=driveFixture([{...driveCourses[0],activo:false}]);
  assert.equal((await hidden({courseId:'first',lessonNumber:1})).status,404);
  const ambiguous=driveFixture([{id:'first',orden:1,clases:[{num:1,driveId:'one'},{num:1,driveId:'two'}]}],{paid:true});
  assert.equal((await ambiguous({courseId:'first',lessonNumber:1})).status,404);
});
test('Drive playback never expands the offer for empty and one-class courses or unsafe metadata',async()=>{
  for(const n of [0,1]){
    const request=driveFixture([{id:'first',orden:1,clases:Array.from({length:n},(_,i)=>({num:i+1,driveId:'fixture'}))}]);
    assert.equal((await request({courseId:'first',lessonNumber:1})).status,n?403:404);
  }
  const request=driveFixture([{id:'first',orden:1,clases:[{num:1,driveId:'https://untrusted.example/video'},{num:2,driveId:'last'}]}]);
  assert.equal((await request({courseId:'first',lessonNumber:1})).status,409);
});
