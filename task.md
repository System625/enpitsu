PS C:\Users\Olamiposi\projects\enpitsu\frontend> npm run lint

> my-app@0.1.0 lint
> eslint


C:\Users\Olamiposi\projects\enpitsu\frontend\app\hooks\useLiveAgent.tsx
    4:25  warning  'saveProject' is defined but never used
       @typescript-eslint/no-unused-vars
    4:38  warning  'loadProject' is defined but never used
       @typescript-eslint/no-unused-vars
   14:10  warning  'Track' is defined but never used
       @typescript-eslint/no-unused-vars
   87:28  warning  'setCurrentProjectId' is assigned a value but never used  @typescript-eslint/no-unused-vars
  100:37  error    Unexpected any. Specify a different type
       @typescript-eslint/no-explicit-any
  205:46  warning  'id' is defined but never used
       @typescript-eslint/no-unused-vars
  234:79  error    Unexpected any. Specify a different type
       @typescript-eslint/no-explicit-any
  236:27  warning  'audioTrack' is assigned a value but never used    
       @typescript-eslint/no-unused-vars
  237:11  warning  'localParticipant' is assigned a value but never used     @typescript-eslint/no-unused-vars
  314:34  error    Unexpected any. Specify a different type
       @typescript-eslint/no-explicit-any

C:\Users\Olamiposi\projects\enpitsu\frontend\components\AgentControlCenter.tsx
  4:10  warning  'AgentVisualizer' is defined but never used  @typescript-eslint/no-unused-vars

C:\Users\Olamiposi\projects\enpitsu\frontend\components\AgentVisualizer.tsx
  3:10  warning  'useMemo' is defined but never used  @typescript-eslint/no-unused-vars

C:\Users\Olamiposi\projects\enpitsu\frontend\components\PushToTalkButton.tsx
  103:9  warning  'startVad' is assigned a value but never used  @typescript-eslint/no-unused-vars

✖ 13 problems (3 errors, 10 warnings)
