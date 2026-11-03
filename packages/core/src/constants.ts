/**
 * The id of the stranger sentinel, the person every dismissed account used to
 * be linked to. Dismissals are their own record now and no person carries this
 * id. Apps still receive it as `strangerPersonId`, because an app built before
 * then compares a sender's person against it.
 */
export const STRANGER_PERSON_ID = "__STRANGER__";
