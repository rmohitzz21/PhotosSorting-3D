import {signIn} from "../../auth";
export default function SignInError(){
 return <main className="welcome"><h1>Sign in again</h1><p>Shoebox couldn’t finish Google sign-in. Start a fresh attempt in this tab.</p><form action={async()=>{"use server";await signIn("google",{redirectTo:"/"});}}><button className="primary">Continue with Google</button></form></main>;
}
