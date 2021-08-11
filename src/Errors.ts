export class ChangeCheckerError extends Error {
    constructor(message: string) {
        super(message);

        Object.setPrototypeOf(this, ChangeCheckerError.prototype);
    }
}

export class ChangeCheckerObjectConflictError extends ChangeCheckerError {
    public source: "FormerModel" | "PresentModel";
    public objectId: string;
    public conflictingObjectLeftPath: Array<string | number>;
    public conflictingObjectLeft: object;
    public conflictingObjectRightPath: Array<string | number>;
    public conflictingObjectRight: object;

    constructor(
        message: string,
        source: "FormerModel" | "PresentModel",
        objectId: string,
        conflictingObjectLeftPath: Array<string | number>,
        conflictingObjectLeft: object,
        conflictingObjectRightPath: Array<string | number>,
        conflictingObjectRight: object) {

        super(message);
        this.source = source;
        this.objectId = objectId;
        this.conflictingObjectLeftPath = conflictingObjectLeftPath;
        this.conflictingObjectLeft = conflictingObjectLeft;
        this.conflictingObjectRightPath = conflictingObjectRightPath;
        this.conflictingObjectRight = conflictingObjectRight;

        Object.setPrototypeOf(this, ChangeCheckerObjectConflictError.prototype);
    }
}
