// Launches a toy on the attached Android device with the autoplay finger and prints its FPS log lines.
// Usage: node mobile/android-soak.mjs <toy> [seconds]   (install first with npm run mobile:android:install)
import {execFileSync, spawn} from 'node:child_process';

const toy=process.argv[2]??'ink';
const seconds=Number(process.argv[3]??30);
const adb=(args)=>execFileSync('adb',args,{encoding:'utf8'});
adb(['logcat','-c']);
adb(['shell','am','start','-S','-n','com.polats.bobo/.MainActivity',...(toy==='hub'?[]:['--es','BOBO_TOY',toy]),'--ez','BOBO_AUTOPLAY','true']);
// Capacitor forwards console.* to logcat under the "Capacitor/Console" tag.
const log=spawn('adb',['logcat','-v','raw','-s','Capacitor/Console:*','chromium:*']);
log.stdout.on('data',(d)=>{
  for(const l of String(d).split('\n'))if(/\[bobo\]|Uncaught|could not start/.test(l))console.log(l.trim());
});
setTimeout(()=>{
  log.kill();
  adb(['shell','am','start','-S','-n','com.polats.bobo/.MainActivity']);
},seconds*1000);
