// Launches a toy on the attached iPhone with autoplay input and prints its FPS log lines.
// Usage: node mobile/device-soak.mjs <toy> [seconds]   (build/install first with npm run mobile:ios:install)
import {spawn,execFileSync} from 'node:child_process';
import {mkdirSync,openSync,readFileSync} from 'node:fs';

const toy=process.argv[2]??'ink';
const seconds=Number(process.argv[3]??30);
const device=process.env.IOS_DEVICE??execFileSync('xcrun',['devicectl','list','devices'],{encoding:'utf8'})
  .split('\n').find((l)=>/iPhone/.test(l)&&/physical/.test(l)&&/available|connected/.test(l))
  ?.match(/[0-9A-F]{8}-[0-9A-F]{16}/)?.[0];
if(!device)throw Error('No attached iPhone found; set IOS_DEVICE');

const env=JSON.stringify(toy==='hub'?{BOBO_AUTOPLAY:'1'}:{BOBO_TOY:toy,BOBO_AUTOPLAY:'1'});
// devicectl block-buffers piped output, so stream the console into a file and read it at the end.
mkdirSync('artifacts',{recursive:true});
const log=`artifacts/soak-${toy}.log`;
const fd=openSync(log,'w');
const child=spawn('xcrun',['devicectl','device','process','launch','--console','--terminate-existing','--device',device,'--environment-variables',env,'com.polats.bobo'],{stdio:['ignore',fd,fd]});
setTimeout(()=>{
  child.kill('SIGTERM');
  setTimeout(()=>{
    for(const l of readFileSync(log,'utf8').split('\n'))
      if(/\[bobo\]|\[error\]|could not start/.test(l))console.log(l.replace(/^.*?\[(log|error|warn)\] - /,'[$1] '));
    // Relaunch normally so the phone is left on the hub, not in autoplay.
    execFileSync('xcrun',['devicectl','device','process','launch','--terminate-existing','--device',device,'com.polats.bobo'],{stdio:'ignore'});
  },1000);
},seconds*1000);
