var Constraint = require('./Constraint')
,   ContactEquation = require('../equations/ContactEquation')
,   Equation = require('../equations/Equation')
,   vec2 = require('../math/vec2')
,   RotationalLockEquation = require('../equations/RotationalLockEquation')

module.exports = PrismaticConstraint;

/**
 * Constraint that only allows bodies to move along a line, relative to each other. See <a href="http://www.iforce2d.net/b2dtut/joints-prismatic">this tutorial</a>.
 *
 * @class PrismaticConstraint
 * @constructor
 * @extends {Constraint}
 * @author schteppe
 * @param {Body}    bodyA
 * @param {Body}    bodyB
 * @param {Object}  options
 * @param {Number}  options.maxForce                Max force to be applied by the constraint
 * @param {Array}   options.localAnchorA            Body A's anchor point, defined in its own local frame.
 * @param {Array}   options.localAnchorB            Body B's anchor point, defined in its own local frame.
 * @param {Array}   options.localAxisA              An axis, defined in body A frame, that body B's anchor point may slide along.
 * @param {Boolean} options.disableRotationalLock   If set to true, bodyB will be free to rotate around its anchor point.
 */
function PrismaticConstraint(bodyA,bodyB,options){
    options = options || {};
    Constraint.call(this,bodyA,bodyB);

    // Get anchors
    var localAnchorA = vec2.fromValues(0,0),
        localAxisA = vec2.fromValues(1,0),
        localAnchorB = vec2.fromValues(0,0);
    if(options.localAnchorA) vec2.copy(localAnchorA, options.localAnchorA);
    if(options.localAxisA)   vec2.copy(localAxisA,   options.localAxisA);
    if(options.localAnchorB) vec2.copy(localAnchorB, options.localAnchorB);

    /**
     * @property localAnchorA
     * @type {Array}
     */
    this.localAnchorA = localAnchorA;

    /**
     * @property localAnchorB
     * @type {Array}
     */
    this.localAnchorB = localAnchorB;

    /**
     * @property localAxisA
     * @type {Array}
     */
    this.localAxisA = localAxisA;

    /*

    The constraint violation for the common axis point is

        g = ( xj + rj - xi - ri ) * t   :=  gg*t

    where r are body-local anchor points, and t is a tangent to the constraint axis defined in body i frame.

        gdot =  ( vj + wj x rj - vi - wi x ri ) * t + ( xj + rj - xi - ri ) * ( wi x t )

    Note the use of the chain rule. Now we identify the jacobian

        G*W = [ -t      -ri x t + t x gg     t    rj x t ] * [vi wi vj wj]

    The rotational part is just a rotation lock.

     */

    var maxForce = this.maxForce = typeof(options.maxForce)==="undefined" ? options.maxForce : Number.MAX_VALUE;

    // Translational part
    var trans = new Equation(bodyA,bodyB,-maxForce,maxForce);
    var ri = new vec2.create(),
        rj = new vec2.create(),
        gg = new vec2.create(),
        t =  new vec2.create();
    trans.computeGq = function(){
        // g = ( xj + rj - xi - ri ) * t
        return vec2.dot(gg,t);
    };
    trans.update = function(){
        var G = this.G,
            xi = bodyA.position,
            xj = bodyB.position;
        vec2.rotate(ri,localAnchorA,bodyA.angle);
        vec2.rotate(rj,localAnchorB,bodyB.angle);
        vec2.add(gg,xj,rj);
        vec2.sub(gg,gg,xi);
        vec2.sub(gg,gg,ri);
        vec2.rotate(t,localAxisA,bodyA.angle+Math.PI/2);

        G[0] = -t[0];
        G[1] = -t[1];
        G[2] = -vec2.crossLength(ri,t) + vec2.crossLength(t,gg);
        G[3] = t[0];
        G[4] = t[1];
        G[5] = vec2.crossLength(rj,t);
    }
    this.equations.push(trans);

    // Rotational part
    if(!options.disableRotationalLock){
        var rot = new RotationalLockEquation(bodyA,bodyB,-maxForce,maxForce);
        this.equations.push(rot);
    }

    /**
     * The position of anchor A relative to anchor B, along the constraint axis.
     * @property position
     * @type {Number}
     */
    this.position = 0;

    /**
     * Set to true to enable lower limit.
     * @property lowerLimitEnabled
     * @type {Boolean}
     */
    this.lowerLimitEnabled = false;

    /**
     * Set to true to enable upper limit.
     * @property upperLimitEnabled
     * @type {Boolean}
     */
    this.upperLimitEnabled = false;

    /**
     * Lower constraint limit. The constraint position is forced to be larger than this value.
     * @property lowerLimit
     * @type {Number}
     */
    this.lowerLimit = 0;

    /**
     * Upper constraint limit. The constraint position is forced to be smaller than this value.
     * @property upperLimit
     * @type {Number}
     */
    this.upperLimit = 1;

    // Equations used for limits
    this.upperLimitEquation = new ContactEquation(bodyA,bodyB);
    this.lowerLimitEquation = new ContactEquation(bodyA,bodyB);

    // Set max/min forces
    this.upperLimitEquation.minForce = this.lowerLimitEquation.minForce = 0;
    this.upperLimitEquation.maxForce = this.lowerLimitEquation.maxForce = maxForce;
}

PrismaticConstraint.prototype = new Constraint();

var worldAxisA = vec2.create(),
    worldAnchorA = vec2.create(),
    worldAnchorB = vec2.create(),
    tmp = vec2.create();

/**
 * Update the constraint equations. Should be done if any of the bodies changed position, before solving.
 * @method update
 */
PrismaticConstraint.prototype.update = function(){
    var eqs = this.equations,
        trans = eqs[0],
        upperLimit = this.upperLimit,
        lowerLimit = this.lowerLimit,
        upperLimitEquation = this.upperLimitEquation,
        lowerLimitEquation = this.lowerLimitEquation,
        bodyA = this.bodyA,
        bodyB = this.bodyB,
        localAxisA = this.localAxisA,
        localAnchorA = this.localAnchorA,
        localAnchorB = this.localAnchorB;

    trans.update();

    // Transform local things to world
    vec2.rotate(worldAxisA, localAxisA, bodyA.angle);
    vec2.rotate(worldAnchorA, localAnchorA, bodyA.angle);
    vec2.add(worldAnchorA, worldAnchorA, bodyA.position);
    vec2.rotate(worldAnchorB, localAnchorB, bodyB.angle);
    vec2.add(worldAnchorB, worldAnchorB, bodyB.position);

    var relPosition = this.position = vec2.dot(worldAnchorB,worldAxisA) - vec2.dot(worldAnchorA,worldAxisA);

    /*
        Limits strategy:
        Add contact equation, with normal along the constraint axis.
        min/maxForce is set so the constraint is repulsive in the correct direction.
        Some offset is added to either equation.ri or .rj to get the correct upper/lower limit.

                 ^
                 |
      upperLimit x
                 |    ------
         anchorB x<---|  B |
                 |    |    |
        ------   |    ------
        |    |   |
        |  A |-->x anchorA
        ------   |
                 x lowerLimit
                 |
                axis
     */

    if(this.upperLimitEnabled && relPosition > upperLimit){
        // Update contact constraint normal, etc
        vec2.scale(upperLimitEquation.ni, worldAxisA, -1);
        vec2.sub(upperLimitEquation.ri, worldAnchorA, bodyA.position);
        vec2.sub(upperLimitEquation.rj, worldAnchorB, bodyB.position);
        vec2.scale(tmp,worldAxisA,upperLimit);
        vec2.add(upperLimitEquation.ri,upperLimitEquation.ri,tmp);
        if(eqs.indexOf(upperLimitEquation)==-1)
            eqs.push(upperLimitEquation);
    } else {
        var idx = eqs.indexOf(upperLimitEquation);
        if(idx != -1) eqs.splice(idx,1);
    }

    if(this.lowerLimitEnabled && relPosition < lowerLimit){
        // Update contact constraint normal, etc
        vec2.scale(lowerLimitEquation.ni, worldAxisA, 1);
        vec2.sub(lowerLimitEquation.ri, worldAnchorA, bodyA.position);
        vec2.sub(lowerLimitEquation.rj, worldAnchorB, bodyB.position);
        vec2.scale(tmp,worldAxisA,lowerLimit);
        vec2.sub(lowerLimitEquation.rj,lowerLimitEquation.rj,tmp);
        if(eqs.indexOf(lowerLimitEquation)==-1)
            eqs.push(lowerLimitEquation);
    } else {
        var idx = eqs.indexOf(lowerLimitEquation);
        if(idx != -1) eqs.splice(idx,1);
    }
};
